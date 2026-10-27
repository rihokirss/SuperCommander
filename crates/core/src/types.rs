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

#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub kind: String,
    pub data: String,
    pub truncated: bool,
    pub size: u64,
    pub mime: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilter {
    pub query: String,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub after: Option<u64>,
    pub before: Option<u64>,
    pub show_hidden: bool,
}
