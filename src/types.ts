export type Language = "en" | "et";
export type Location = { source: string; path: string };
export type Entry = {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number;
  hidden: boolean;
  isParent?: boolean;
};
export type Listing = { entries: Entry[]; done: boolean; error?: string };
export type Place = { name: string; path: string; kind: string };
export type Tab = {
  id: string;
  location: Location;
  history: Location[];
  historyIndex: number;
};
export type PaneState = { tabs: Tab[]; activeTab: string };
export type Settings = {
  language: Language;
  theme: "dark" | "light" | "system";
  panes: PaneState[];
  bookmarks: Place[];
  showHidden: boolean;
  glass: boolean;
  transparency?: number;
  workspaceCollapsed?: boolean;
  collapsedGroups?: string[];
  networkLocations?: Place[];
  hiddenNetworkPaths?: string[];
  density: "comfortable" | "compact";
  profiles: SftpProfile[];
  trustedHosts: Record<string, string>;
  sshConfigPath?: string;
};
export type CatalogHost = {
  alias: string;
  profile: SftpProfile;
  warnings: string[];
  disabled: boolean;
  forwards: SavedForward[];
};
export type SavedForward = {
  localPort: number;
  remoteHost: string;
  remotePort: number;
};
export type SshCatalog = {
  path: string;
  text: string;
  revision: string | null;
  hosts: CatalogHost[];
  warnings: string[];
};
export type ForwardInfo = {
  id: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  error?: string;
};
export type SftpProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  keyPath: string;
  saveSecret: boolean;
};
export type Conflict = "ask" | "replace" | "skip" | "keepBoth";
export type Operation =
  | "copy"
  | "move"
  | "delete"
  | "trash"
  | "zip"
  | "extract";
export type JobRequest = {
  id: string;
  operation: Operation;
  source: string;
  paths: string[];
  destination: Location;
  conflict: Conflict;
  sourceConnection?: string | null;
  destinationConnection?: string | null;
};
export type FileClipboard = {
  source: string;
  paths: string[];
  cut: boolean;
  revision: number;
  connection?: string;
};
export type ClipboardPaste = { clipboard: FileClipboard; request: JobRequest };
export type JobEvent = {
  id: string;
  state:
    | "queued"
    | "running"
    | "conflict"
    | "completed"
    | "cancelled"
    | "failed";
  current: string;
  bytes: number;
  total: number;
  completed: number;
  errors: string[];
  conflictPath?: string;
};
export type Job = JobEvent & { operation: Operation; count: number };
export type RenameRules = {
  find: string;
  replace: string;
  regex: boolean;
  caseMode: "keep" | "lower" | "upper";
  numbering: boolean;
  start: number;
  prefix: string;
};
export type RenameItem = {
  path: string;
  before: string;
  after: string;
  error?: string;
};
export type Preview = {
  kind: "text" | "image" | "pdf" | "unsupported";
  data: string;
  truncated: boolean;
  size: number;
  mime: string;
};
export type Bootstrap = {
  home: string;
  places: Place[];
  drives: Place[];
  network?: Place[];
  networkError?: string;
  settings: Settings | null;
  locale: string;
};
export type SearchFilter = {
  query: string;
  minSize?: number;
  maxSize?: number;
  after?: number;
  before?: number;
  showHidden: boolean;
};
