//! Newline-delimited JSON framing with an oversized-line guard.
//!
//! ACP over stdio is one JSON-RPC message per line. The decoder is fed raw
//! chunks and yields complete lines. A line longer than [`MAX_LINE_BYTES`] is
//! dropped (never buffered past the limit) and reported once as
//! [`Frame::Oversized`]; decoding resumes at the next newline.

/// 16 MiB: the largest single message either side may send.
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Line(String),
    /// A line exceeded the limit and was discarded.
    Oversized,
}

#[derive(Debug)]
pub struct LineDecoder {
    buf: Vec<u8>,
    discarding: bool,
    max: usize,
}

impl Default for LineDecoder {
    fn default() -> Self {
        Self::with_max(MAX_LINE_BYTES)
    }
}

impl LineDecoder {
    pub fn with_max(max: usize) -> Self {
        Self { buf: Vec::new(), discarding: false, max }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Frame> {
        let mut out = Vec::new();
        let mut rest = chunk;
        loop {
            match rest.iter().position(|b| *b == b'\n') {
                Some(i) => {
                    self.absorb(&rest[..i], &mut out);
                    self.end_line(&mut out);
                    rest = &rest[i + 1..];
                }
                None => {
                    self.absorb(rest, &mut out);
                    break;
                }
            }
        }
        out
    }

    /// Flush a trailing line that was not newline-terminated (EOF).
    pub fn finish(&mut self) -> Vec<Frame> {
        let mut out = Vec::new();
        self.end_line(&mut out);
        out
    }

    fn absorb(&mut self, seg: &[u8], out: &mut Vec<Frame>) {
        if self.discarding || seg.is_empty() {
            return;
        }
        if self.buf.len() + seg.len() > self.max {
            self.buf = Vec::new();
            self.discarding = true;
            out.push(Frame::Oversized);
            return;
        }
        self.buf.extend_from_slice(seg);
    }

    fn end_line(&mut self, out: &mut Vec<Frame>) {
        if self.discarding {
            self.discarding = false;
            return;
        }
        let mut line = std::mem::take(&mut self.buf);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            return;
        }
        out.push(Frame::Line(String::from_utf8_lossy(&line).into_owned()));
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum EncodeError {
    EmbeddedNewline,
    TooLong,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EncodeError::EmbeddedNewline => write!(f, "message contains a newline"),
            EncodeError::TooLong => write!(f, "message exceeds the 16 MiB line limit"),
        }
    }
}

/// Frame one outgoing message: trimmed, single line, newline-terminated.
pub fn encode(message: &str) -> Result<Vec<u8>, EncodeError> {
    encode_owned(message.to_owned())
}

/// [`encode`] for a message the caller gives up: framed in its own buffer, so
/// no second copy of a large message is made.
pub fn encode_owned(message: String) -> Result<Vec<u8>, EncodeError> {
    let mut bytes = message.into_bytes();
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    if bytes.iter().any(|&b| b == b'\n' || b == b'\r') {
        return Err(EncodeError::EmbeddedNewline);
    }
    if bytes.len() > MAX_LINE_BYTES {
        return Err(EncodeError::TooLong);
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(frames: Vec<Frame>) -> Vec<String> {
        frames
            .into_iter()
            .map(|f| match f {
                Frame::Line(l) => l,
                Frame::Oversized => "<oversized>".to_string(),
            })
            .collect()
    }

    #[test]
    fn splits_multiple_lines_in_one_chunk() {
        let mut d = LineDecoder::default();
        assert_eq!(lines(d.push(b"{\"a\":1}\n{\"b\":2}\n")), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn joins_a_line_split_across_chunks() {
        let mut d = LineDecoder::default();
        assert!(d.push(b"{\"a\":").is_empty());
        assert!(d.push(b"1").is_empty());
        assert_eq!(lines(d.push(b"}\n")), vec!["{\"a\":1}"]);
    }

    #[test]
    fn strips_crlf_and_skips_blank_lines() {
        let mut d = LineDecoder::default();
        assert_eq!(lines(d.push(b"x\r\n\n\r\ny\n")), vec!["x", "y"]);
    }

    #[test]
    fn keeps_multibyte_characters_split_across_chunks() {
        let mut d = LineDecoder::default();
        let bytes = "é\n".as_bytes();
        assert!(d.push(&bytes[..1]).is_empty());
        assert_eq!(lines(d.push(&bytes[1..])), vec!["é"]);
    }

    #[test]
    fn oversized_line_is_reported_once_and_decoding_recovers() {
        let mut d = LineDecoder::with_max(8);
        let mut frames = d.push(b"123456789");
        frames.extend(d.push(b"more more more"));
        frames.extend(d.push(b"\nok\n"));
        assert_eq!(lines(frames), vec!["<oversized>", "ok"]);
    }

    #[test]
    fn line_exactly_at_the_limit_is_accepted() {
        let mut d = LineDecoder::with_max(4);
        assert_eq!(lines(d.push(b"abcd\n")), vec!["abcd"]);
    }

    #[test]
    fn finish_flushes_an_unterminated_line() {
        let mut d = LineDecoder::default();
        assert!(d.push(b"tail").is_empty());
        assert_eq!(lines(d.finish()), vec!["tail"]);
        assert!(d.finish().is_empty());
    }

    #[test]
    fn encode_appends_one_newline() {
        assert_eq!(encode("{\"a\":1}\n").unwrap(), b"{\"a\":1}\n");
    }

    #[test]
    fn encode_rejects_embedded_newlines() {
        assert_eq!(encode("a\nb"), Err(EncodeError::EmbeddedNewline));
    }
}
