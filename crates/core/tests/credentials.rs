#![cfg(windows)]

use commander_core::settings;
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

struct OwnedCredential(Vec<u16>);
impl Drop for OwnedCredential {
    fn drop(&mut self) {
        // The UUID target belongs exclusively to this test, even after a panic.
        unsafe { CredDeleteW(self.0.as_ptr(), CRED_TYPE_GENERIC, 0) };
    }
}

#[test]
fn keyring_upgrade_preserves_legacy_windows_targets_and_utf16_passwords() {
    let id = format!("dependency-compat-{}", uuid::Uuid::new_v4());
    // Keyring 3 used this target and a UTF-16LE blob. Seed it directly through
    // Windows so the test is independent of the upgraded keyring constructor.
    let mut target = wide(&format!("{id}.SuperCommander"));
    let _cleanup = OwnedCredential(target.clone());
    let mut username = wide(&id);
    let mut blob: Vec<u8> = "old-õ-🔑"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut native: CREDENTIALW = unsafe { std::mem::zeroed() };
    native.Type = CRED_TYPE_GENERIC;
    native.TargetName = target.as_mut_ptr();
    native.UserName = username.as_mut_ptr();
    native.CredentialBlobSize = blob.len() as u32;
    native.CredentialBlob = blob.as_mut_ptr();
    native.Persist = CRED_PERSIST_LOCAL_MACHINE;
    assert_ne!(unsafe { CredWriteW(&native, 0) }, 0);
    assert_eq!(settings::secret(&id).unwrap().as_deref(), Some("old-õ-🔑"));

    settings::save_secret(&id, "new-ä-🔐").unwrap();
    let mut stored = std::ptr::null_mut();
    assert_ne!(
        unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut stored) },
        0
    );
    let bytes = unsafe {
        std::slice::from_raw_parts(
            (*stored).CredentialBlob,
            (*stored).CredentialBlobSize as usize,
        )
    }
    .to_vec();
    unsafe { CredFree(stored.cast()) };
    assert_eq!(bytes.len() % 2, 0);
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    assert_eq!(String::from_utf16(&units).unwrap(), "new-ä-🔐");
    settings::delete_secret(&id).unwrap();
    assert_eq!(settings::secret(&id).unwrap(), None);
    // Removing a missing credential remains idempotent.
    settings::delete_secret(&id).unwrap();
}
