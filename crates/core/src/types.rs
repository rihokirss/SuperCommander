use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub source: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,
    pub hidden: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Place {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    pub save_secret: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Copy,
    Move,
    Delete,
    Trash,
    Zip,
    Extract,
    Synchronize,
    Restore,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    Ask,
    Replace,
    Skip,
    KeepBoth,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub id: String,
    pub operation: Operation,
    pub source: String,
    pub paths: Vec<String>,
    pub destination: Location,
    pub conflict: Conflict,
    #[serde(default)]
    pub source_connection: Option<String>,
    #[serde(default)]
    pub destination_connection: Option<String>,
    #[serde(default)]
    pub source_bindings: Option<Vec<crate::clipboard::Binding>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: String,
    pub state: String,
    pub current: String,
    pub bytes: u64,
    pub total: u64,
    pub completed: u64,
    pub errors: Vec<String>,
    pub conflict_path: Option<String>,
    pub preserved_count: u64,
    pub preserved: Vec<PreservedFile>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedFile {
    pub source: String,
    pub original: String,
    pub path: String,
    pub record: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRules {
    pub find: String,
    pub replace: String,
    pub regex: bool,
    pub case_mode: String,
    pub numbering: bool,
    pub start: u64,
    pub prefix: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenameItem {
    pub path: String,
    pub before: String,
    pub after: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub connection: Option<String>,
    pub kind: String,
    pub data: String,
    pub truncated: bool,
    pub size: u64,
    pub mime: String,
    pub start_line: u64,
    pub end_line: u64,
    pub has_more: bool,
    pub encoding: String,
    pub line_ending: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchFilter {
    pub query: String,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub after: Option<u64>,
    pub before: Option<u64>,
    pub show_hidden: bool,
    pub name_mode: String,
    pub case_sensitive: bool,
    pub content: String,
    pub content_regex: bool,
    pub whole_word: bool,
    pub recursive: bool,
    pub kind: String,
    pub exclude: String,
    pub max_results: usize,
}
impl Default for SearchFilter {
    fn default() -> Self {
        Self {
            query: String::new(),
            min_size: None,
            max_size: None,
            after: None,
            before: None,
            show_hidden: false,
            name_mode: "contains".into(),
            case_sensitive: false,
            content: String::new(),
            content_regex: false,
            whole_word: false,
            recursive: true,
            kind: "all".into(),
            exclude: String::new(),
            max_results: 20_000,
        }
    }
}
