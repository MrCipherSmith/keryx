use std::sync::atomic::{AtomicUsize, Ordering};

/// Increment a counter without exceeding its concurrent-job limit.
pub(crate) fn try_take(count: &AtomicUsize, limit: usize) -> bool {
    let mut current = count.load(Ordering::Acquire);
    while current < limit {
        match count.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturation_preserves_the_counter() {
        let count = AtomicUsize::new(0);
        assert!(try_take(&count, 1));
        assert!(!try_take(&count, 1));
        assert_eq!(count.load(Ordering::Relaxed), 1);
        count.fetch_sub(1, Ordering::Release);
        assert!(try_take(&count, 1));
    }
}
