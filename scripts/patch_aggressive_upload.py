from pathlib import Path

# Client: use large upload chunks by default to reduce request/round-trip overhead.
p = Path('public/app.js')
s = p.read_text()
s = s.replace("xhr.timeout = 60000;", "xhr.timeout = 120000;", 1)
s = s.replace("const chunkSize = 1024 * 1024;", "// Always-on aggressive upload: fewer round trips, larger sustained network writes.\n  const chunkSize = 8 * 1024 * 1024;", 1)
s = s.replace("if (retryCount >= 8) throw error;", "if (retryCount >= 5) throw error;", 1)
s = s.replace("await new Promise(resolve => setTimeout(resolve, 1500));", "await new Promise(resolve => setTimeout(resolve, 650));", 1)
p.write_text(s)

# Server: accept the larger 8 MiB client chunks with headroom.
p = Path('server.js')
s = p.read_text()
s = s.replace("limit: '2mb'", "limit: '10mb'", 1)
p.write_text(s)
