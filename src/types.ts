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
export type Bookmark = Place & { source?: string };
export type FileProperties = {
  file: Entry;
  created: number | null;
  accessed: number | null;
  readonly: boolean | null;
  hidden: boolean | null;
  system: boolean | null;
  compressed: boolean | null;
  encrypted: boolean | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  linkTarget: string | null;
  editable: { readonly: boolean; hidden: boolean; mode: boolean };
  connection: string | null;
  revision: string;
};
export type AttributeChanges = {
  readonly?: boolean;
  hidden?: boolean;
  mode?: number;
  modeSet?: number;
  modeClear?: number;
};
export type SizeSummary = {
  files: number;
  folders: number;
  links: number;
  bytes: number;
  errors: string[];
  errorCount: number;
  done: boolean;
  cancelled: boolean;
};
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
  bookmarks: Bookmark[];
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
  | "extract"
  | "synchronize";
export type ComparisonOptions = {
  content: boolean;
  recursive: boolean;
  showHidden: boolean;
  caseSensitive: boolean;
  exclude: string;
  maxEntries: number;
  timeTolerance: number;
};
export type ComparisonDirection = "left_to_right" | "right_to_left";
export type ComparisonNode = {
  entry: Entry;
  relative: string;
  error: string | null;
  empty: boolean;
};
export type ComparisonRow = {
  id: number;
  path: string;
  status: string;
  left: ComparisonNode | null;
  right: ComparisonNode | null;
  blocked: string | null;
  toLeft: boolean;
  toRight: boolean;
};
export type ComparisonProgress = {
  scanned: number;
  bytes: number;
  side: number;
  current: string;
  done: boolean;
  cancelled: boolean;
  limited: boolean;
  errors: string[];
};
export type ComparisonRoot = {
  location: Location;
  connection: string | null;
  writable: boolean;
};
export type ComparisonPlan = {
  left: ComparisonRoot;
  right: ComparisonRoot;
  options: ComparisonOptions;
  rows: ComparisonRow[];
  progress: ComparisonProgress;
};
export type ComparisonResult = { id: string; plan: ComparisonPlan };
export type ComparisonChoice = { id: number; direction: ComparisonDirection };
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
    | "preparing"
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
  preservedCount?: number;
  preserved?: { original: string; path: string; record: string }[];
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
  connection?: string | null;
  kind: "text" | "image" | "pdf" | "unsupported";
  data: string;
  truncated: boolean;
  size: number;
  mime: string;
  startLine?: number;
  endLine?: number;
  hasMore?: boolean;
  encoding?: string;
  lineEnding?: string;
};
export type TextPosition = { line: number; column: number };
export type TextHit = TextPosition & { length: number; wrapped: boolean };
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
  nameMode?: "contains" | "glob" | "regex";
  content?: string;
  contentRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  recursive?: boolean;
  kind?: "all" | "files" | "folders";
  exclude?: string;
  maxResults?: number;
};
export type SearchHit = {
  entry: Entry;
  line: number | null;
  column: number | null;
  preview: string | null;
  start: number;
  end: number;
};
export type SearchBatch = {
  matches: SearchHit[];
  scanned: number;
  folders: number;
  found: number;
  skippedBinary: number;
  skippedLongLines: number;
  errors: string[];
  errorCount: number;
  done: boolean;
  cancelled: boolean;
  limited: boolean;
  connection: string | null;
};
