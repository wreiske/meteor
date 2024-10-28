export interface ObserveCallbacks {
  added?: (document: any) => void;
  changed?: (newDocument: any, oldDocument: any) => void;
  removed?: (oldDocument: any) => void;
  [key: string]: any;
}