import { Uri as URI } from '@ali/ide-core-common';

/**
 * Marker的严重程度
 */
export enum MarkerSeverity {
  Hint = 1,
  Info = 2,
  Warning = 4,
  Error = 8,
}

export const enum MarkerTag {
  Unnecessary = 1,
  Deprecated = 2,
}

/**
 * diagnosis的相关信息
 */
export interface IRelatedInformation {
  resource: URI;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * A structure defining a problem/warning/etc.
 */
export interface IMarkerData {
  code?: string;
  severity: MarkerSeverity;
  message: string;
  source?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  relatedInformation?: IRelatedInformation[];
  tags?: MarkerTag[];
}
