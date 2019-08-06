import * as React from 'react';
import * as styles from './index.module.less';
import { RecycleTree, TreeViewAction } from '@ali/ide-core-browser/lib/components';

export interface OpenedEditorTreeProps {
  nodes: any[];
  actions?: TreeViewAction[];
  commandActuator?: (commandId: string, params: any) => {};
  width?: number;
  height?: number;
  onSelect?: any;
}

export const OpenedEditorTree = ({
  nodes,
  width,
  actions,
  commandActuator,
  height,
  onSelect,
}: React.PropsWithChildren<OpenedEditorTreeProps>) => {
  const OPEN_EDIROT_NODE_HEIGHT = 22;
  const openEditorRef = React.createRef<HTMLDivElement>();
  const containerHeight = height && height > 0 ? height : (openEditorRef.current && openEditorRef.current.clientHeight) || 0;
  const containerWidth = width && width > 0 ? width : (openEditorRef.current && openEditorRef.current.clientWidth) || 0;

  const contentHeight = nodes.length * OPEN_EDIROT_NODE_HEIGHT;
  const shouldShowNumbers = containerHeight && Math.ceil(containerHeight / OPEN_EDIROT_NODE_HEIGHT) || 0;

  const scrollContainerStyle = {
    width: containerWidth,
    height: containerHeight,
  };

  const scrollContentStyle = {
    width: width || 0,
    height: containerHeight ? contentHeight < containerHeight ? containerHeight : contentHeight : 0,
  };

  const openEditorAttrs = {
    ref: openEditorRef,
  };

  return <div className={styles.kt_openeditor_container} {...openEditorAttrs}>
    <RecycleTree
      nodes={ nodes }
      scrollContainerStyle={ scrollContainerStyle }
      scrollContentStyle={ scrollContentStyle }
      onSelect={ onSelect }
      contentNumber={ shouldShowNumbers }
      itemLineHeight={ OPEN_EDIROT_NODE_HEIGHT }
      leftPadding = { 15 }
      foldable = { false }
      actions = { actions }
      commandActuator = { commandActuator }
    ></RecycleTree>
  </div>;
};
