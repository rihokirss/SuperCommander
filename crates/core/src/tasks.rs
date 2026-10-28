//! Cancellation shared by independently scheduled IPC calls and blocking workers.
use anyhow::{bail, Result};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Default, Clone)]
pub struct Tasks(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    running: HashMap<String, Arc<AtomicBool>>,
    pending: VecDeque<(String, Instant)>,
}
pub struct Task {
    tasks: Tasks,
    id: String,
    pub cancel: Arc<AtomicBool>,
}
impl Tasks {
    pub fn start(&self, id: String) -> Result<Task> {
        let mut state = self.0.lock().unwrap();
        if state.running.contains_key(&id) {
            bail!("This task ID is already running");
        }
        let now = Instant::now();
        state
            .pending
            .retain(|(_, time)| now.duration_since(*time) < Duration::from_secs(60));
        let cancelled = state.pending.iter().any(|(key, _)| key == &id);
        state.pending.retain(|(key, _)| key != &id);
        let cancel = Arc::new(AtomicBool::new(cancelled));
        state.running.insert(id.clone(), cancel.clone());
        Ok(Task {
            tasks: self.clone(),
            id,
            cancel,
        })
    }
    pub fn cancel(&self, id: String) {
        let mut state = self.0.lock().unwrap();
        if let Some(cancel) = state.running.get(&id) {
            cancel.store(true, Ordering::Relaxed);
        } else if !state.pending.iter().any(|(key, _)| key == &id) {
            // Cancel may arrive before start, or after completion. Keep these
            // short-lived requests bounded rather than leaking one per dialog.
            state.pending.push_back((id, Instant::now()));
            while state.pending.len() > 256 {
                state.pending.pop_front();
            }
        }
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        self.tasks.0.lock().unwrap().running.remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_start_and_while_running_is_preserved() {
        let tasks = Tasks::default();
        tasks.cancel("before".into());
        let before = tasks.start("before".into()).unwrap();
        assert!(before.cancel.load(Ordering::Relaxed));
        let running = tasks.start("running".into()).unwrap();
        assert!(!running.cancel.load(Ordering::Relaxed));
        assert!(tasks.start("running".into()).is_err());
        tasks.cancel("running".into());
        assert!(running.cancel.load(Ordering::Relaxed));
        drop(before);
        drop(running);
        assert!(tasks.0.lock().unwrap().running.is_empty());
        assert!(!tasks
            .start("before".into())
            .unwrap()
            .cancel
            .load(Ordering::Relaxed));
    }
    #[test]
    fn unknown_or_late_cancellations_have_bounded_lifetimes() {
        let tasks = Tasks::default();
        for index in 0..1000 {
            tasks.cancel(index.to_string());
        }
        assert_eq!(tasks.0.lock().unwrap().pending.len(), 256);
        tasks.cancel("999".into());
        assert_eq!(tasks.0.lock().unwrap().pending.len(), 256);
        tasks
            .0
            .lock()
            .unwrap()
            .pending
            .push_back(("expired".into(), Instant::now() - Duration::from_secs(61)));
        assert!(!tasks
            .start("expired".into())
            .unwrap()
            .cancel
            .load(Ordering::Relaxed));
    }
}
