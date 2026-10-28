use anyhow::Result;
use chrono::{Datelike, Local, TimeZone, Timelike};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zip::{extra_fields::ExtraField, read::ZipFile, write::FullFileOptions};

const WINDOWS_EPOCH: u64 = 116_444_736_000_000_000;

#[derive(Clone, Debug)]
pub(crate) struct Metadata {
    pub modified: Option<SystemTime>,
    pub mode: Option<u32>,
}
impl Metadata {
    pub fn from_zip<R: std::io::Read>(file: &ZipFile<'_, R>) -> Self {
        let ntfs = file.extra_data_fields().find_map(|field| match field {
            ExtraField::Ntfs(time) => {
                let ticks = time.mtime();
                let delta = Duration::new(
                    ticks.abs_diff(WINDOWS_EPOCH) / 10_000_000,
                    (ticks.abs_diff(WINDOWS_EPOCH) % 10_000_000 * 100) as u32,
                );
                if ticks >= WINDOWS_EPOCH {
                    UNIX_EPOCH.checked_add(delta)
                } else {
                    UNIX_EPOCH.checked_sub(delta)
                }
            }
            _ => None,
        });
        let utc = file.extra_data_fields().find_map(|field| match field {
            ExtraField::ExtendedTimestamp(time) => time
                .mod_time()
                .and_then(|s| UNIX_EPOCH.checked_add(Duration::from_secs(s as u64))),
            _ => None,
        });
        // DOS timestamps have no UTC offset and encode the writer's local time.
        // Prefer UTC extra fields, and resolve a DST overlap to its earlier time.
        let dos = file
            .last_modified()
            .and_then(|time| {
                Local
                    .with_ymd_and_hms(
                        time.year() as i32,
                        time.month() as u32,
                        time.day() as u32,
                        time.hour() as u32,
                        time.minute() as u32,
                        time.second() as u32,
                    )
                    .earliest()
            })
            .map(SystemTime::from);
        Self {
            modified: ntfs.or(utc).or(dos),
            mode: file.unix_mode().map(|m| m & 0o777),
        }
    }
    pub fn seconds(&self) -> u64 {
        self.modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs())
    }
    pub fn properties(&self, file: crate::Entry) -> crate::properties::Properties {
        let mut info = crate::properties::Properties::basic(file);
        info.mode = self.mode;
        info.readonly = self.mode.map(|m| m & 0o222 == 0);
        if let Some(duration) = self
            .modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        {
            info.stamp = duration.as_nanos().to_string();
        }
        info
    }
}

pub(crate) fn options(
    info: &crate::properties::Properties,
) -> Result<FullFileOptions<'static, 'static>> {
    let mut options = FullFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(info.file.size >= u32::MAX as u64)
        .unix_permissions(info.mode.unwrap_or(if info.file.is_dir {
            0o755
        } else if info.readonly == Some(true) {
            0o444
        } else {
            0o644
        }));
    let nanos = info
        .stamp
        .parse::<u128>()
        .ok()
        .unwrap_or(info.file.modified as u128 * 1_000_000_000);
    if let Ok(seconds) = u64::try_from(nanos / 1_000_000_000) {
        if let Some(time) =
            UNIX_EPOCH.checked_add(Duration::new(seconds, (nanos % 1_000_000_000) as u32))
        {
            let local: chrono::DateTime<Local> = time.into();
            if let Ok(dos) = zip::DateTime::from_date_and_time(
                local.year().try_into().unwrap_or(0),
                local.month() as u8,
                local.day() as u8,
                local.hour() as u8,
                local.minute() as u8,
                local.second() as u8,
            ) {
                options = options.last_modified_time(dos);
            }
        }
        if let Ok(seconds) = u32::try_from(seconds) {
            let mut utc = vec![1];
            utc.extend(seconds.to_le_bytes());
            options.add_extra_field(0x5455, utc.into_boxed_slice(), false)?;
        }
        if let Ok(ticks) = u64::try_from(nanos / 100 + WINDOWS_EPOCH as u128) {
            let mut ntfs = vec![0; 4];
            ntfs.extend(1u16.to_le_bytes());
            ntfs.extend(24u16.to_le_bytes());
            ntfs.extend(ticks.to_le_bytes());
            ntfs.extend(ticks.to_le_bytes());
            ntfs.extend(ticks.to_le_bytes());
            options.add_extra_field(0x000a, ntfs.into_boxed_slice(), false)?;
        }
    }
    Ok(options)
}
