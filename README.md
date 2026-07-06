# Perplexity Comet MCP

[![npm version](https://img.shields.io/npm/v/perplexity-comet-mcp.svg)](https://www.npmjs.com/package/perplexity-comet-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/perplexity-comet-mcp.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20WSL-lightgrey.svg)]()

A production-grade MCP (Model Context Protocol) server that bridges Claude Code with Perplexity's Comet browser for autonomous web browsing, research, and multi-tab workflow management.

---

## Why Perplexity Comet MCP?

| Approach | Limitation |
|----------|------------|
| **Search APIs** | Static text, no interaction, no login support |
| **Browser Automation** | Single-agent model overwhelms context, fragments focus |
| **Perplexity Comet MCP** | Claude codes while Comet handles browsing autonomously |

This is a significantly enhanced fork of [hanzili/comet-mcp](https://github.com/hanzili/comet-mcp) with Windows support, smart completion detection, robust connection handling, and full tab management.

---

## Features

### Core Capabilities

- **Autonomous Web Browsing** - Comet navigates, clicks, types, and extracts data while Claude focuses on coding
- **Deep Research Mode** - Leverage Perplexity's research capabilities for comprehensive analysis
- **Login Wall Handling** - Access authenticated content through real browser sessions
- **Dynamic Content** - Full JavaScript rendering and interaction support

### Enhanced Features (New in This Fork)

| Feature | Description |
|---------|-------------|
| **Windows/WSL Support** | Full compatibility with Windows and WSL environments |
| **Tab Management** | Track, switch, and close browser tabs with protection |
| **Smart Completion** | Detect response completion without fixed timeouts |
| **Auto-Reconnect** | Exponential backoff recovery from connection drops |
| **One-Shot Reliability** | Pre-operation health checks for consistent execution |
| **Agentic Auto-Trigger** | Automatically triggers browser actions from natural prompts |

---

## Comparison with Original

| Capability | Original | Enhanced |
|------------|----------|----------|
| Platform Support | macOS | Windows, WSL, macOS |
| Available Tools | 6 | 9 (+comet_tabs, +comet_upload, +youcom_search) |
| Completion Detection | Fixed timeout | Stability-based |
| Connection Recovery | None | Auto-reconnect with backoff |
| Tab Management | None | Full registry and control |
| Health Monitoring | None | Cached health checks |
| Last Tab Protection | None | Prevents browser crash |

---

## Installation

### Prerequisites

- Node.js 18 or higher
- [Perplexity Comet Browser](https://www.perplexity.ai/comet) installed
- Claude Code or compatible MCP client

### Install via npm

```bash
npm install -g perplexity-comet-mcp
```

### Install from Source

```bash
git clone https://github.com/RapierCraft/perplexity-comet-mcp.git
cd perplexity-comet-mcp
npm install
npm run build
```

### Configure Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json` or VS Code settings):

```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "node",
      "args": ["/path/to/perplexity-comet-mcp/dist/index.js"]
    }
  }
}
```

**Windows Users:** Use the full Windows path:

```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\perplexity-comet-mcp\\dist\\index.js"]
    }
  }
}
```

---

## Tools Reference

### comet_connect

Establish connection to Comet browser. Auto-launches if not running.

```
Parameters: None
Returns: Connection status message
```

**Example:**
```
> comet_connect
Comet started with debug port 9223
Connected to Perplexity (cleaned 2 old tabs)
```

---

### comet_ask

Send a prompt to Comet and wait for the complete response. Automatically triggers agentic browsing for URLs and action-oriented requests.

```
Parameters:
  - prompt (required): Question or task for Comet
  - newChat (optional): Start fresh conversation (default: false)
  - timeout (optional): Max wait time in ms (default: 120000)

Returns: Complete response text
```

**Examples:**

```
# Simple research query
> comet_ask "What are the latest features in Python 3.12?"

# Agentic browsing (auto-triggered)
> comet_ask "Go to github.com/trending and list top Python repos"

# Site-specific data extraction
> comet_ask "Check the price of iPhone 15 on amazon.com"
```

---

### comet_poll

Check status and progress of ongoing tasks. Returns the response if completed.

```
Parameters: None
Returns: Status (IDLE/WORKING/COMPLETED), steps taken, or final response
```

**Example:**
```
> comet_poll
Status: WORKING
Browsing: https://github.com/trending
Current: Scrolling page

Steps:
  - Preparing to assist you
  - Navigating to github.com
  - Clicking on Trending
  - Scrolling page
```

---

### comet_stop

Halt the current agentic task if it goes off track.

```
Parameters: None
Returns: Confirmation message
```

---

### comet_screenshot

Capture a screenshot of the current browser view.

```
Parameters: None
Returns: PNG image data
```

---

### comet_tabs

View and manage browser tabs. Essential for multi-tab workflows.

```
Parameters:
  - action (optional): "list" (default), "switch", or "close"
  - domain (optional): Domain to match (e.g., "github.com")
  - tabId (optional): Specific tab ID

Returns: Tab listing or action confirmation
```

**Examples:**

```
# List all external tabs
> comet_tabs
2 browsing tab(s) open:
  - AGENT-BROWSING: github.com [ACTIVE]
    URL: https://github.com/trending
  - AGENT-BROWSING: stackoverflow.com
    URL: https://stackoverflow.com/questions

# Switch to a tab
> comet_tabs action="switch" domain="stackoverflow.com"
Switched to stackoverflow.com (https://stackoverflow.com/questions)

# Close a tab (protected if last tab)
> comet_tabs action="close" domain="github.com"
Closed github.com
```

**Tab Protection:**
- Cannot close the last external browsing tab (prevents Comet crash)
- Internal tabs (chrome://, Perplexity UI) are automatically filtered

---

### comet_mode

Switch Perplexity search modes for different use cases.

```
Parameters:
  - mode (optional): "search", "research", "labs", or "learn"

Returns: Current mode or confirmation of switch
```

| Mode | Use Case |
|------|----------|
| search | Quick web searches |
| research | Deep, comprehensive analysis |
| labs | Data analytics and visualization |
| learn | Educational explanations |

---

### comet_upload

Upload files to file input elements on web pages. Essential for posting images to social media, attaching files to forms, or uploading documents.

```
Parameters:
  - filePath (required): Absolute path to the file to upload
  - selector (optional): CSS selector for specific file input
  - checkOnly (optional): If true, only checks what file inputs exist

Returns: Success message or error with available inputs
```

**Examples:**

```
# Upload an image to the first file input found
> comet_upload filePath="/home/user/screenshot.png"
File uploaded successfully: /home/user/screenshot.png

# Check what file inputs exist on the page
> comet_upload filePath="dummy" checkOnly=true
Found 2 file input(s) on the page:
  1. #image-upload
  2. input[name="attachment"]

# Upload to a specific input
> comet_upload filePath="/home/user/doc.pdf" selector="#attachment-input"
File uploaded successfully: /home/user/doc.pdf
```

**Workflow for posting images:**
1. Navigate to the post creation page (e.g., Reddit, Twitter)
2. Use `comet_upload checkOnly=true` to find file inputs
3. Use `comet_upload filePath="..." selector="..."` to attach the file
4. Continue with form submission

---

### youcom_search

Optional You.com web search results for live external context. Set `YDC_API_KEY` to enable it.

```
Parameters:
  - query (required): Search query
  - count (optional): Number of results to return
  - freshness (optional): day, week, month, or year
```

**Example:**

```
> youcom_search {"query":"playwright locator best practices","count":5}
```

---

## Architecture

```
┌─────────────────┐     MCP Protocol      ┌──────────────────┐
│   Claude Code   │ ◄──────────────────► │  Perplexity      │
│   (Your IDE)    │                       │  Comet MCP       │
└─────────────────┘                       └────────┬─────────┘
                                                   │
                                          Chrome DevTools
                                            Protocol
                                                   │
                                          ┌────────▼─────────┐
                                          │  Comet Browser   │
                                          │  (Perplexity)    │
                                          └──────────────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │   External       │
                                          │   Websites       │
                                          └──────────────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `index.ts` | MCP server and tool handlers |
| `cdp-client.ts` | Chrome DevTools Protocol client with reconnection logic |
| `comet-ai.ts` | Perplexity interaction, prompt submission, response extraction |
| `types.ts` | TypeScript interfaces for tabs, state, and CDP types |

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `COMET_PATH` | Custom path to Comet executable | Auto-detected |
| `COMET_PORT` | CDP debugging port | 9223 |
| `YDC_API_KEY` | Enables the optional `youcom_search` tool | unset |

### Custom Comet Path

```bash
# Windows
set COMET_PATH=C:\Custom\Path\comet.exe

# macOS/Linux
export COMET_PATH=/custom/path/to/Comet.app/Contents/MacOS/Comet
```

---

## Troubleshooting

### Connection Issues

**Problem:** `Error: Failed to list targets: ECONNREFUSED`

**Solutions:**
1. Ensure Comet browser is installed
2. Close any existing Comet instances
3. Run `comet_connect` to auto-start with correct flags

---

**Problem:** `WebSocket connection closed` during long tasks

**Solution:** This version handles reconnection automatically. If persistent, increase timeout:

```
comet_ask prompt="..." timeout=180000
```

---

### Windows-Specific Issues

**Problem:** `ECONNRESET` errors on Windows

**Solution:** This version includes PowerShell-based fetch workarounds. Ensure:
1. PowerShell is available in PATH
2. No firewall blocking localhost:9223

---

**Problem:** Comet not found on Windows

**Solution:** Set custom path:
```bash
set COMET_PATH=%LOCALAPPDATA%\Perplexity\Comet\Application\comet.exe
```

---

### WSL-Specific Issues

**Problem:** `WSL cannot connect to Windows localhost:9223`

**Explanation:** WSL2 uses a separate network namespace by default. The MCP uses Chrome DevTools Protocol (CDP) which requires WebSocket connections to Windows localhost.

**Solution:** Enable WSL mirrored networking:

1. Create or edit `%USERPROFILE%\.wslconfig` (e.g., `C:\Users\YourName\.wslconfig`):
```ini
[wsl2]
networkingMode=mirrored
```

2. Restart WSL:
```powershell
wsl --shutdown
```

3. Open a new WSL terminal and try again.

**Alternative:** Run Claude Code from Windows PowerShell instead of WSL.

---

**Problem:** `UNC paths are not supported` warnings

**Explanation:** This is a benign warning from PowerShell when launched from WSL. The MCP handles this automatically.

---

### Tab Management Issues

**Problem:** `Cannot close - this is the only browsing tab`

**Explanation:** This is intentional protection. Comet requires at least one external tab. Open another tab first, then close the unwanted one.

---

## Development

### Build from Source

```bash
git clone https://github.com/RapierCraft/perplexity-comet-mcp.git
cd perplexity-comet-mcp
npm install
npm run build
```

### Run in Development

```bash
npm run dev
```

### Run Tests

```bash
npm test
```

### Project Structure

```
perplexity-comet-mcp/
├── src/
│   ├── index.ts        # MCP server entry point
│   ├── cdp-client.ts   # CDP connection management
│   ├── comet-ai.ts     # AI interaction logic
│   └── types.ts        # TypeScript definitions
├── dist/               # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

### Development Guidelines

1. Maintain TypeScript strict mode compliance
2. Add tests for new features
3. Update documentation for API changes
4. Follow existing code style

---

## Attribution

This project is an enhanced fork of [comet-mcp](https://github.com/hanzili/comet-mcp) by [hanzili](https://github.com/hanzili).

### Key Enhancements by RapierCraft

- Windows and WSL platform support
- Tab management system (comet_tabs tool)
- Smart completion detection
- Auto-reconnect with exponential backoff
- Health check caching
- Agentic prompt auto-transformation
- Last tab protection
- Internal tab filtering

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Links

- [Perplexity Comet Browser](https://www.perplexity.ai/comet)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code](https://claude.ai/code)
- [Original comet-mcp](https://github.com/hanzili/comet-mcp)

---

Built with precision by [RapierCraft](https://github.com/RapierCraft)
