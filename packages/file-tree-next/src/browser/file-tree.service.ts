import throttle from 'lodash/throttle';

import { Injectable, Autowired } from '@opensumi/di';
import { Tree, ITree, ITreeNodeOrCompositeTreeNode, TreeNodeType } from '@opensumi/ide-components';
import {
  CommandService,
  IContextKeyService,
  URI,
  EDITOR_COMMANDS,
  Disposable,
  FILE_COMMANDS,
  PreferenceService,
  Deferred,
  Event,
  Emitter,
  IApplicationService,
  ILogger,
  path,
  Throttler,
  pSeries,
} from '@opensumi/ide-core-browser';
import { CorePreferences } from '@opensumi/ide-core-browser/lib/core-preferences';
import { LabelService } from '@opensumi/ide-core-browser/lib/services';
import {
  FileChange,
  IFileServiceClient,
  FileChangeType,
  FileStat,
  IFileServiceWatcher,
} from '@opensumi/ide-file-service/lib/common';
import { IIconService } from '@opensumi/ide-theme';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { IFileTreeAPI, IFileTreeService } from '../common';
import { Directory, File } from '../common/file-tree-node.define';

import { FileContextKey } from './file-contextkey';
import { FileTreeDecorationService } from './services/file-tree-decoration.service';

const { Path } = path;

export interface IMoveChange {
  source: FileChange;
  target: FileChange;
}

export interface ITreeIndent {
  indent: number;
  baseIndent: number;
}

export interface ISortNode {
  node: Directory | File;
  path: string | URI;
}

@Injectable()
export class FileTreeService extends Tree implements IFileTreeService {
  private static DEFAULT_REFRESH_DELAY = 100;
  private static DEFAULT_FILE_EVENT_REFRESH_DELAY = 100;

  @Autowired(IFileTreeAPI)
  private readonly fileTreeAPI: IFileTreeAPI;

  @Autowired(CommandService)
  private readonly commandService: CommandService;

  @Autowired(IContextKeyService)
  private readonly contextKeyService: IContextKeyService;

  @Autowired(IWorkspaceService)
  private readonly workspaceService: IWorkspaceService;

  @Autowired(CorePreferences)
  private readonly corePreferences: CorePreferences;

  @Autowired(PreferenceService)
  private readonly preferenceService: PreferenceService;

  @Autowired(LabelService)
  public readonly labelService: LabelService;

  @Autowired(FileTreeDecorationService)
  public readonly decorationService: FileTreeDecorationService;

  @Autowired(IFileServiceClient)
  private readonly fileServiceClient: IFileServiceClient;

  @Autowired(IIconService)
  public readonly iconService: IIconService;

  @Autowired(IApplicationService)
  private readonly appService: IApplicationService;

  @Autowired(ILogger)
  private readonly logger: ILogger;

  @Autowired(FileContextKey)
  private fileContextKey: FileContextKey;

  private _cacheNodesMap: Map<string, File | Directory> = new Map();

  private _fileServiceWatchers: Map<string, IFileServiceWatcher> = new Map();

  // 文件系统Change事件队列
  private _changeEventDispatchQueue = new Set<string>();

  private _roots: FileStat[] | null;

  // 是否进行文件事件监听标志值
  private _readyToWatch = false;
  // 等待监听的路径队列
  private _watchRootsQueue: URI[] = [];

  private _isCompactMode: boolean;

  private willRefreshDeferred: Deferred<void> | null;

  private requestFlushEventSignalEmitter: Emitter<void> = new Emitter();

  private effectedNodes: Directory[] = [];
  private refreshThrottler: Throttler = new Throttler();
  private fileEventRefreshResolver;

  private readonly onWorkspaceChangeEmitter = new Emitter<Directory>();
  private readonly onTreeIndentChangeEmitter = new Emitter<ITreeIndent>();
  private readonly onFilterModeChangeEmitter = new Emitter<boolean>();

  // 筛选模式开关
  private _filterMode = false;
  private _baseIndent: number;
  private _indent: number;

  get filterMode() {
    return this._filterMode;
  }

  get baseIndent() {
    return this._baseIndent;
  }

  get indent() {
    return this._indent;
  }

  get onWorkspaceChange() {
    return this.onWorkspaceChangeEmitter.event;
  }

  get onTreeIndentChange() {
    return this.onTreeIndentChangeEmitter.event;
  }

  get onFilterModeChange() {
    return this.onFilterModeChangeEmitter.event;
  }

  get willRefreshPromise() {
    return this.willRefreshDeferred?.promise;
  }

  get requestFlushEventSignalEvent(): Event<void> {
    return this.requestFlushEventSignalEmitter.event;
  }

  get isCompactMode(): boolean {
    return this._isCompactMode;
  }

  set isCompactMode(value: boolean) {
    this._isCompactMode = value;
  }

  get contextKey() {
    return this.fileContextKey;
  }

  async init() {
    this._roots = await this.workspaceService.roots;
    await this.preferenceService.ready;
    this._baseIndent = this.preferenceService.get('explorer.fileTree.baseIndent') || 8;
    this._indent = this.preferenceService.get('explorer.fileTree.indent') || 8;
    this._isCompactMode = this.preferenceService.get('explorer.compactFolders') as boolean;

    this.toDispose.push(
      this.workspaceService.onWorkspaceChanged((roots) => {
        this._roots = roots;
        // 切换工作区时更新文件树
        const newRootUri = new URI(roots[0].uri);
        const newRoot = new Directory(
          this,
          undefined,
          newRootUri,
          newRootUri.displayName,
          roots[0],
          this.fileTreeAPI.getReadableTooltip(newRootUri),
        );
        this._root = newRoot;
        this.onWorkspaceChangeEmitter.fire(newRoot);
        this.refresh();
      }),
    );

    this.toDispose.push(
      this.workspaceService.onWorkspaceFileExcludeChanged(() => {
        this.refresh();
      }),
    );

    this.toDispose.push(
      Disposable.create(() => {
        this._roots = null;
      }),
    );

    this.toDispose.push(
      this.corePreferences.onPreferenceChanged((change) => {
        if (change.preferenceName === 'explorer.fileTree.baseIndent') {
          this._baseIndent = (change.newValue as number) || 8;
          this.onTreeIndentChangeEmitter.fire({
            indent: this.indent,
            baseIndent: this.baseIndent,
          });
        } else if (change.preferenceName === 'explorer.fileTree.indent') {
          this._indent = (change.newValue as number) || 8;
          this.onTreeIndentChangeEmitter.fire({
            indent: this.indent,
            baseIndent: this.baseIndent,
          });
        } else if (change.preferenceName === 'explorer.compactFolders') {
          this._isCompactMode = change.newValue as boolean;
          this.refresh();
        }
      }),
    );
  }

  initContextKey(dom: HTMLDivElement) {
    this.fileContextKey.initScopedContext(dom);
  }

  public startWatchFileEvent() {
    this._readyToWatch = true;
    return Promise.all(
      this._watchRootsQueue.map(async (uri) => {
        await this.watchFilesChange(uri);
      }),
    );
  }

  async resolveChildren(parent?: Directory) {
    let children: (File | Directory)[] = [];
    if (!parent) {
      // 加载根目录
      if (!this._roots) {
        this._roots = await this.workspaceService.roots;
      }
      if (this.isMultipleWorkspace) {
        const rootUri = new URI(this.workspaceService.workspace?.uri);
        let rootName = rootUri.displayName;
        rootName = rootName.slice(0, rootName.lastIndexOf('.'));
        const fileStat = {
          ...this.workspaceService.workspace,
          isDirectory: true,
        } as FileStat;
        const root = new Directory(
          this,
          undefined,
          rootUri,
          rootName,
          fileStat,
          this.fileTreeAPI.getReadableTooltip(rootUri),
        );
        // 创建Root节点并引入root文件目录
        this.root = root;
        return [root];
      } else {
        if (this._roots.length > 0) {
          children = await (await this.fileTreeAPI.resolveChildren(this, this._roots[0])).children;
          children.forEach((child) => {
            // 根据workspace更新Root名称
            const rootName = this.workspaceService.getWorkspaceName(child.uri);
            if (rootName && rootName !== child.name) {
              (child as Directory).updateMetaData({
                name: rootName,
              });
            }
          });
          this.watchFilesChange(new URI(this._roots[0].uri));
          this.root = children[0] as Directory;
          return children;
        }
      }
    } else {
      // 根节点加载子节点
      if (Directory.isRoot(parent) && this.isMultipleWorkspace) {
        // 加载根目录
        const roots = await this.workspaceService.roots;
        for (const fileStat of roots) {
          const child = this.fileTreeAPI.toNode(
            this as ITree,
            fileStat,
            parent,
            this.workspaceService.getWorkspaceName(new URI(fileStat.uri)),
          );
          this.watchFilesChange(new URI(fileStat.uri));
          children = children.concat(child);
        }
        return children;
      }
      // 加载子目录
      if (parent.uri) {
        const data = await this.fileTreeAPI.resolveChildren(
          this,
          parent.uri.toString(),
          parent,
          this.isCompactMode && !Directory.isRoot(parent),
        );
        children = data.children;
        // 有概率获取不到Filestat，易发生在外部删除多文件情况下
        const childrenParentStat = data.filestat;
        // 需要排除软连接下的直接空目录折叠，否则会导致路径计算错误
        // 但软连接目录下的其他目录不受影响
        if (
          !!childrenParentStat &&
          this.isCompactMode &&
          !parent.filestat.isSymbolicLink &&
          !Directory.isRoot(parent)
        ) {
          const parentURI = new URI(childrenParentStat.uri);
          if (parent && parent.parent) {
            const parentName = (parent.parent as Directory).uri.relative(parentURI)?.toString();
            if (parentName && parentName !== parent.name) {
              parent.updateMetaData({
                name: parentName,
                uri: parentURI,
                tooltip: this.fileTreeAPI.getReadableTooltip(parentURI),
                fileStat: childrenParentStat,
              });
            }
          }
        }
        return children;
      }
    }
    return [];
  }

  async watchFilesChange(uri: URI) {
    if (!this._readyToWatch) {
      this._watchRootsQueue.push(uri);
      return;
    }
    const watcher = await this.fileServiceClient.watchFileChanges(uri);
    this.toDispose.push(watcher);
    this.toDispose.push(
      watcher.onFilesChanged((changes: FileChange[]) => {
        this.onFilesChanged(changes);
      }),
    );
    this._fileServiceWatchers.set(uri.toString(), watcher);
  }

  private isContentFile(node: any | undefined) {
    return !!node && 'filestat' in node && !node.filestat.isDirectory;
  }

  private isFileContentChanged(change: FileChange): boolean {
    return change.type === FileChangeType.UPDATED && this.isContentFile(this.getNodeByPathOrUri(change.uri));
  }

  private getAffectedChanges(changes: FileChange[]): FileChange[] {
    const affectChange: FileChange[] = [];
    for (const change of changes) {
      const isFile = this.isFileContentChanged(change);
      if (!isFile) {
        affectChange.push(change);
      }
    }
    return affectChange;
  }

  private isRootAffected(changes: FileChange[]): boolean {
    if (this._roots) {
      return changes.some(
        (change) =>
          change.type > FileChangeType.UPDATED &&
          this._roots &&
          this._roots.find((root) => change.uri.indexOf(root.uri) >= 0),
      );
    }
    return false;
  }

  private async onFilesChanged(changes: FileChange[]) {
    const nodes = await this.getAffectedNodes(this.getAffectedChanges(changes));
    if (nodes.length > 0) {
      this.effectedNodes = this.effectedNodes.concat(nodes);
    } else if (!(nodes.length > 0) && this.isRootAffected(changes)) {
      this.effectedNodes.push(this.root as Directory);
    }
    // 文件事件引起的刷新进行队列化处理，每 200 ms 处理一次刷新任务
    return this.refreshThrottler.queue(this.doDelayRefresh.bind(this));
  }

  private async doDelayRefresh() {
    return new Promise<void>((resolve) => {
      this.fileEventRefreshResolver = resolve;
      setTimeout(this.refreshEffectNode, FileTreeService.DEFAULT_FILE_EVENT_REFRESH_DELAY);
    });
  }

  private refreshEffectNode = () => {
    const nodes = this.effectedNodes.slice(0);
    this.effectedNodes = [];
    const hasRoot = nodes.find((node) => Directory.isRoot(node));
    if (hasRoot) {
      // 如果存在根节点刷新，则 500 ms 时间内的刷新都可合并为一次根节点刷新
      this.refresh();
    } else {
      for (const node of nodes) {
        this.refresh(node);
      }
    }
    if (this.fileEventRefreshResolver) {
      this.fileEventRefreshResolver();
    }
  };

  public async getFileTreeNodePathByUri(uri: URI) {
    // 软链文件在这种情况下无法获取到相对路径
    if (!uri) {
      return;
    }
    let rootStr;
    if (!this.isMultipleWorkspace) {
      rootStr = this.workspaceService.workspace?.uri;
      if (rootStr) {
        const rootUri = new URI(rootStr);
        if (rootUri.isEqualOrParent(uri)) {
          return new Path(this.root?.path || '').join(rootUri.relative(uri)!.toString()).toString();
        }
      }
    } else {
      if (!this._roots) {
        this._roots = await this.workspaceService.roots;
      }
      rootStr = this._roots.find((root) => new URI(root.uri).isEqualOrParent(uri))?.uri;
      if (rootStr) {
        const rootUri = new URI(rootStr);
        if (rootUri.isEqualOrParent(uri)) {
          // 多工作区模式下，路径需要拼接项目名称
          return new Path(this.root?.path || '/')
            .join(rootUri.displayName)
            .join(rootUri.relative(uri)!.toString())
            .toString();
        }
      }
    }
  }

  // 软链接目录下，文件节点路径不能通过uri去获取，存在偏差
  public async moveNodeByPath(
    from: Directory,
    to: Directory,
    oldName: string,
    newName: string,
    type: TreeNodeType = TreeNodeType.TreeNode,
  ) {
    const oldPath = new Path(from.path).join(oldName).toString();
    const newPath = new Path(to.path).join(newName).toString();
    if (oldPath && newPath && newPath !== oldPath) {
      const movedNode = from.moveNode(oldPath, newPath);
      // 更新节点除了 name 以外的其他属性，如 fileStat，tooltip 等，否则节点数据可能会异常
      if (movedNode) {
        (movedNode as File).updateMetaData({
          uri: to.uri.resolve(newName),
          fileStat: {
            ...to.filestat,
            uri: to.uri.resolve(newName).toString(),
            isDirectory: type === TreeNodeType.TreeNode ? false : true,
          },
          tooltip: this.fileTreeAPI.getReadableTooltip(to.uri.resolve(newName)),
        });
      }
      return movedNode;
    }
  }

  public async addNode(node: Directory, newName: string, type: TreeNodeType) {
    let tempFileStat: FileStat;
    let tempName: string;
    const namePaths = Path.splitPath(newName);
    // 处理a/b/c/d这类目录
    if (namePaths.length > 1) {
      let tempUri = node.uri;
      for (const path of namePaths) {
        tempUri = tempUri.resolve(path);
      }
      if (!this.isCompactMode || Directory.isRoot(node)) {
        tempName = namePaths[0];
      } else {
        if (type === TreeNodeType.CompositeTreeNode) {
          tempName = newName;
        } else {
          tempName = namePaths.slice(0, namePaths.length - 1).join(Path.separator);
        }
      }
    } else {
      tempName = newName;
    }
    tempFileStat = {
      uri: node.uri.resolve(tempName).toString(),
      isDirectory: type === TreeNodeType.CompositeTreeNode || namePaths.length > 1,
      isSymbolicLink: false,
      lastModification: new Date().getTime(),
    };
    const addNode = await this.fileTreeAPI.toNode(this as ITree, tempFileStat, node as Directory, tempName);
    if (addNode) {
      // 节点创建失败时，不需要添加
      node.addNode(addNode);
    }
    return addNode;
  }

  // 用于精准删除节点，软连接目录下的文件删除
  public async deleteAffectedNodeByPath(path: string, notRefresh?: boolean) {
    const node = this.getNodeByPathOrUri(path);
    if (node && node.parent) {
      // 压缩节点情况下，刷新父节点目录即可
      if (node.displayName.indexOf(Path.separator) > 0 && !notRefresh) {
        this.refresh(node.parent as Directory);
      } else {
        (node.parent as Directory).removeNode(node.path);
      }
    }
  }

  public async deleteAffectedNodes(uris: URI[], changes: FileChange[] = []) {
    const nodes: File[] = [];
    for (const uri of uris) {
      const node = this.getNodeByPathOrUri(uri);
      if (node) {
        nodes.push(node as File);
      }
    }
    for (const node of nodes) {
      // 一旦更新队列中已包含该文件，临时剔除删除事件传递
      if (!node?.parent || this._changeEventDispatchQueue.has(node?.parent.path)) {
        continue;
      }
      await this.deleteAffectedNodeByPath(node.path);
    }
    return changes.filter((change) => change.type !== FileChangeType.DELETED);
  }

  private async getAffectedNodes(changes: FileChange[]): Promise<Directory[]> {
    const nodes: Directory[] = [];
    for (const change of changes) {
      const uri = new URI(change.uri);
      const node = this.getNodeByPathOrUri(uri.parent);
      if (node) {
        nodes.push(node as Directory);
      }
    }
    return nodes;
  }

  private isFileURI(str: string) {
    return /^file:\/\//.test(str);
  }

  /**
   *
   * @param pathOrUri 路径或者URI对象
   * @param compactMode 是否开启压缩模式查找
   *
   */
  getNodeByPathOrUri(pathOrUri: string | URI) {
    let path: string | undefined;
    let pathURI: URI | undefined;
    if (typeof pathOrUri !== 'string') {
      pathURI = pathOrUri;
      pathOrUri = pathOrUri.toString();
    } else if (this.isFileURI(pathOrUri)) {
      pathURI = new URI(pathOrUri);
    } else if (!this.isFileURI(pathOrUri) && typeof pathOrUri === 'string') {
      path = pathOrUri;
    }
    if (this.isFileURI(pathOrUri) && !!pathURI) {
      let rootStr;
      if (!this.isMultipleWorkspace) {
        rootStr = this.workspaceService.workspace?.uri;
      } else if (this._roots) {
        rootStr = this._roots.find((root) => new URI(root.uri).isEqualOrParent(pathURI!))?.uri;
      }
      if (this.root && rootStr) {
        const rootUri = new URI(rootStr);
        if (rootUri.isEqualOrParent(pathURI)) {
          path = new Path(this.root.path).join(rootUri.relative(pathURI)!.toString()).toString();
        }
      }
    }

    if (path) {
      // 压缩模式下查找不到对应节点时，需要查看是否已有包含的文件夹存在
      // 如当收到的变化是 /root/test_folder/test_file，而当前缓存中的路径只有/root/test_folder/test_folder2的情况
      // 需要用当前缓存路径校验是否存在包含关系，这里/root/test_folder/test_folder2与/root/test_folder存在路径包含关系
      // 此时应该重载/root下的文件，将test_folder目录折叠并清理缓存
      if (this.isCompactMode && !this._cacheNodesMap.has(path)) {
        const allNearestPath = Array.from(this._cacheNodesMap.keys()).filter((cache) => cache.indexOf(path!) >= 0);
        let nearestPath;
        for (const nextPath of allNearestPath) {
          const depth = Path.pathDepth(nextPath);
          if (nearestPath) {
            if (depth < nearestPath.depth) {
              nearestPath = {
                path: nextPath,
                depth,
              };
            }
          } else {
            nearestPath = {
              path: nextPath,
              depth,
            };
          }
        }
        if (nearestPath) {
          return this.root?.getTreeNodeByPath(nearestPath.path) as File | Directory;
        }
      }
      return this.root?.getTreeNodeByPath(path) as File | Directory;
    }
  }

  sortComparator(a: ITreeNodeOrCompositeTreeNode, b: ITreeNodeOrCompositeTreeNode) {
    if (a.constructor === b.constructor) {
      // numeric 参数确保数字为第一排序优先级
      return a.name.localeCompare(b.name, 'en', { numeric: true }) as any;
    }
    return a.type === TreeNodeType.CompositeTreeNode ? -1 : b.type === TreeNodeType.CompositeTreeNode ? 1 : 0;
  }

  get contextMenuContextKeyService() {
    if (this.fileContextKey) {
      return this.fileContextKey.service;
    } else {
      return this.contextKeyService;
    }
  }

  public reWatch() {
    // 重连时重新监听文件变化
    for (const [uri, watcher] of this._fileServiceWatchers) {
      watcher.dispose();
      this.watchFilesChange(new URI(uri));
    }
  }

  get isMultipleWorkspace(): boolean {
    return !!this.workspaceService.workspace && !this.workspaceService.workspace.isDirectory;
  }

  getDisplayName(uri: URI) {
    return this.workspaceService.getWorkspaceName(uri);
  }

  /**
   * 刷新指定下的所有子节点
   */
  async refresh(node: Directory = this.root as Directory) {
    // 如果正在刷新，就不要创建新的 Defer
    // 否则会导致下面的 callback 闭包 resolve 的仍然是之前捕获的旧 defer
    if (!this.willRefreshDeferred) {
      this.willRefreshDeferred = new Deferred();
    }
    if (!node) {
      return;
    }
    if (!Directory.is(node) && node.parent) {
      node = node.parent as Directory;
    }

    // 队列化刷新动作减少更新成本
    this._changeEventDispatchQueue.add(node.path);
    return this.doHandleQueueChange();
  }

  private doHandleQueueChange = throttle(
    async () => {
      try {
        // 询问是否此时可进行刷新事件
        await this.requestFlushEventSignalEmitter.fireAndAwait();
        await this.flushEventQueue();
      } catch (error) {
        this.logger.error('flush file change event queue error:', error);
      } finally {
        this.onNodeRefreshedEmitter.fire();
        this.willRefreshDeferred?.resolve();
        this.willRefreshDeferred = null;
      }
    },
    FileTreeService.DEFAULT_REFRESH_DELAY,
    {
      leading: true,
      trailing: true,
    },
  );

  /**
   * 将文件排序并删除多余文件（指已有父文件夹将被删除）
   */
  public sortPaths(_paths: (string | URI)[]) {
    const paths = _paths.slice();
    const nodes = paths
      .map((path) => ({
        node: this.getNodeByPathOrUri(path),
        path,
      }))
      .filter((node) => node && !!node.node) as ISortNode[];

    nodes.sort((pathA, pathB) => {
      // 直接获取节点深度比通过path取深度更可靠
      const pathADepth = pathA.node?.depth || 0;
      const pathBDepth = pathB.node?.depth || 0;
      return pathADepth - pathBDepth;
    });

    const roots = [] as ISortNode[];
    for (let index = nodes.length - 1; index >= 0; index--) {
      // 从后往前遍历整个列表
      const later = nodes[index];
      let canRemove = false;
      for (let j = 0; j < index; j++) {
        const former = nodes[j];
        // 如果树的某个父节点包括了当前项
        if (Directory.is(former) && later.node.path.startsWith(former.node.path)) {
          canRemove = true;
        }
      }
      if (!canRemove) {
        roots.push(later);
      }
    }
    return roots;
  }

  public flushEventQueue = async () => {
    if (!this._changeEventDispatchQueue || this._changeEventDispatchQueue.size === 0) {
      return;
    }
    const queue = Array.from(this._changeEventDispatchQueue);

    const effectedRoots = this.sortPaths(queue);
    const promise = pSeries(
      effectedRoots.map((root) => async () => {
        if (Directory.is(root.node)) {
          await (root.node as Directory).refresh();
        }
      }),
    );
    // 重置更新队列
    this._changeEventDispatchQueue.clear();
    return await promise;
  };

  /**
   * 打开文件
   * @param uri
   */
  public openFile(uri: URI) {
    // 当打开模式为双击同时预览模式生效时，默认单击为预览文件
    const preview = this.preferenceService.get<boolean>('editor.previewMode');
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, {
      disableNavigate: true,
      preview,
      focus: true,
    });
  }

  /**
   * 打开并固定文件
   * @param uri
   */
  public openAndFixedFile(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, {
      disableNavigate: true,
      preview: false,
      focus: true,
    });
  }

  /**
   * 在侧边栏打开文件
   * @param {URI} uri
   * @memberof FileTreeService
   */
  public openToTheSide(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, {
      disableNavigate: true,
      split: 4 /** right */,
    });
  }

  /**
   * 比较选中的两个文件
   * @param original
   * @param modified
   */
  public compare(original: URI, modified: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.COMPARE.id, {
      original,
      modified,
    });
  }

  /**
   * 开关筛选输入框
   */
  public toggleFilterMode() {
    this._filterMode = !this.filterMode;
    this.onFilterModeChangeEmitter.fire(this.filterMode);
    this.fileContextKey.filesExplorerFilteredContext.set(this.filterMode);
    // 清理掉输入值
    if (this.filterMode === false) {
      // 退出时若需要做 filter 值清理以及聚焦操作
      this.commandService.executeCommand(FILE_COMMANDS.LOCATION.id);
    }
  }

  public locationToCurrentFile = () => {
    this.commandService.executeCommand(FILE_COMMANDS.LOCATION.id);
  };
}
