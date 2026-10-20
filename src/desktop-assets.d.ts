declare module '*.asset' {
  const path: string;
  export default path;
}

declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[]; shared?: boolean });
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
  }
}
