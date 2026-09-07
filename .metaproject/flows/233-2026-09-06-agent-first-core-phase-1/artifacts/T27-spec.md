# T27 strict security guard propagation

AFC15/17: incomplete checks must never pass a strict guard or flow gate. Advisory decisions retain incomplete diagnostics while safe deterministic output floor always applies. Catch failures return constant safe diagnostics, strict/unknown mode blocks. Flow missing/invalid evidence remains incomplete through source runGate; no error details or source bytes are echoed. Regression first: incomplete latest report and induced HMAC failure under enforced/advisory modes.
