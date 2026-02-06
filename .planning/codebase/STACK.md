# Technology Stack

**Analysis Date:** 2026-02-06

## Languages

**Primary:**
- JavaScript (ESM modules) - All source code
- Node.js/JavaScript (ES2020+) - CLI tool and library

**Secondary:**
- None - JavaScript/Node.js only

## Runtime

**Environment:**
- Node.js 18+ (as specified in `package.json` engines)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- SuperDoc Editor - `@harbour-enterprises/superdoc@^1.0.0` - Headless DOCX document editing and manipulation
- Commander.js - `commander@^12.0.0` - CLI command-line interface and argument parsing

**Testing:**
- Node.js built-in `node:test` module - Native test runner (no external test framework)
- Node.js built-in `node:assert/strict` - Assertion library for tests

**Build/Dev:**
- None - No build step required, runs directly as ESM modules

## Key Dependencies

**Critical:**
- `@harbour-enterprises/superdoc@^1.0.0` - Core library providing headless editor capabilities for DOCX manipulation with track changes and comment support. Critical to all document operations.
- `jsdom@^24.0.0` - Virtual DOM environment required by SuperDoc for headless Node.js execution. Creates the DOM context needed for editor initialization.
- `diff-match-patch@^1.0.5` - Google's diff/match/patch library used for word-level document diffing to produce minimal track changes.

**File & Archive Operations:**
- `archiver@^7.0.1` - ZIP archive creation (used for DOCX packaging/manipulation)
- `unzipper@^0.12.3` - ZIP extraction for reading DOCX file contents
- `fs/promises` - Built-in Node.js filesystem API for async file I/O

**Utility:**
- `commander@^12.0.0` - CLI framework for command parsing and option handling

## Configuration

**Environment:**
- No environment variables required for core functionality
- File-based configuration only (DOCX input files, edits JSON files)
- Optional author/user configuration passed programmatically or via CLI options

**Build:**
- No build configuration files present
- No webpack, vite, esbuild, or other bundler configuration
- Direct Node.js ESM module execution

**Runtime Modes:**
- `editing` mode - Standard document editing mode
- `suggesting` mode - Track changes enabled for change tracking

## File Format Support

**Input/Output:**
- DOCX (Office Open XML) - Primary input/output format via SuperDoc
- JSON - Intermediate representation (IR) and edits files

## Platform Requirements

**Development:**
- Node.js 18.0.0 or higher
- npm or compatible package manager
- DOCX files for testing

**Production:**
- Node.js 18.0.0 or higher (headless server/container)
- Read/write access to filesystem for DOCX file operations
- No external services or APIs required
- Typical deployment: Cloud functions, Lambda, container, or CLI tool in CI/CD

---

*Stack analysis: 2026-02-06*
