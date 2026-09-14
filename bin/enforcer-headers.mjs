#!/usr/bin/env node
// headersHelper for the Enforcer MCP server.
//
// Claude Code runs this before connecting to the server the plugin registers
// (.mcp.json), and again after a 401. It prints the headers that authenticate
// the request, read from the SAME credential the governor's hooks use — which
// is the whole point: sign in once, with /enforcer-governor:login, and both
// the governor and the MCP server are signed in.
//
// Signed out, it prints {} and exits 0. The server then answers 401 with its
// OAuth discovery challenge, so a client that can sign in on its own still
// can; nothing here makes that path worse.
import { authHeaders } from '../src/credentials.mjs';

let headers = {};
try { headers = await authHeaders(); } catch { headers = {}; }
process.stdout.write(JSON.stringify(headers));
