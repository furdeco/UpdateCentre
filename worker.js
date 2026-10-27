/**
 * Furdeco Update Centre — Cloudflare Workers (ES modules)
 *
 * Required Worker secrets:
 *   ADMIN_PASSWORD  - admin password used by the existing index.html
 *   GITHUB_TOKEN    - fine-grained GitHub token with Contents: Read and write
 *
 * Optional plain-text Worker variables:
 *   GITHUB_OWNER=furdeco
 *   GITHUB_REPO=UpdateCentre
 *   GITHUB_BRANCH=main
 *   GITHUB_FILE_PATH=updates.json
 *
 * Routes:
 *   GET  /health
 *   GET  /updates
 *   GET  /sheet-data  (public Zoho XLSX proxy for interactive Update Centre)
 *   POST /admin-login
 *   POST /publish
 *   POST /edit
 *   POST /delete
 */

const SITE_ORIGIN = "https://furdeco.github.io";
const GITHUB_API = "https://api.github.com";
const MAX_TITLE_LENGTH = 160;
const MAX_NOTE_LENGTH = 12000;
const MAX_CATEGORY_LABEL_LENGTH = 60;

const ALLOWED_CATEGORIES = new Set([
  "seller-updates",
  "booking-updates",
  "crew",
  "customer-care",
  "operations",
  "incoming",
  "outbound",
  "emails",
  "chats"
]);

function responseHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  });

  // Permit the GitHub Pages site. Requests without Origin (e.g. curl) can
  // still be used for diagnostics; browser requests from other sites cannot.
  if (origin === SITE_ORIGIN) headers.set("Access-Control-Allow-Origin", SITE_ORIGIN);
  if (origin === SITE_ORIGIN) headers.set("Access-Control-Allow-Credentials", "false");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(request) });
}

function getConfig(env) {
  return {
    owner: env.GITHUB_OWNER || "furdeco",
    repo: env.GITHUB_REPO || "UpdateCentre",
    branch: env.GITHUB_BRANCH || "main",
    path: env.GITHUB_FILE_PATH || "updates.json",
    token: env.GITHUB_TOKEN
  };
}

function isAuthorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(env.ADMIN_PASSWORD && match && safeEqual(match[1], env.ADMIN_PASSWORD));
}

// Constant-time comparison for equal-length UTF-8 strings.
function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left[i] ^ right[i];
  return result === 0;
}

async function parseJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validDate(value, fallback) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? fallback : value;
}

function validateUpdate(input) {
  const keyword = String(input.keyword || "").trim();
  const note = String(input.note || "").trim();
  const category = String(input.category || "operations").trim();
  const categoryLabel = String(input.categoryLabel || "").trim().slice(0, MAX_CATEGORY_LABEL_LENGTH);

  if (!keyword || !note) return { error: "Update title and details are required." };
  if (keyword.length > MAX_TITLE_LENGTH) return { error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` };
  if (note.length > MAX_NOTE_LENGTH) return { error: `Update details must be ${MAX_NOTE_LENGTH} characters or fewer.` };
  if (category === "custom") {
    if (!categoryLabel) return { error: "A custom category name is required." };
  } else if (!ALLOWED_CATEGORIES.has(category)) {
    return { error: "Invalid update category." };
  }
  return { keyword, note, category, categoryLabel };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Furdeco-Update-Centre-Worker"
  };
}

async function githubRequest(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...githubHeaders(token), ...(options.headers || {}) }
  });
}

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

async function readUpdates(env) {
  const config = getConfig(env);
  if (!config.token) throw new Error("Missing GITHUB_TOKEN secret in Cloudflare Worker settings.");

  const url = `${GITHUB_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodePath(config.path)}?ref=${encodeURIComponent(config.branch)}`;
  const response = await githubRequest(url, config.token);

  if (response.status === 404) return { updates: [], sha: null, config };
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GitHub could not read ${config.path} (HTTP ${response.status}). ${detail}`);
  }

  const file = await response.json();
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error("GitHub did not return a Base64 file. Check that updates.json exists and is a normal file under 1 MB.");
  }

  // Decode UTF-8 correctly, including Hindi and other non-ASCII characters.
  const binary = atob(file.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    throw new Error("updates.json is not valid JSON. Fix the file before publishing new updates.");
  }

  const updates = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.updates) ? parsed.updates : null;
  if (!updates) throw new Error('updates.json must contain either an array or an object with an "updates" array.');
  return { updates, sha: file.sha, config };
}

async function writeUpdates(env, updates, sha, config, action = "update") {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodePath(config.path)}`;
  const bytes = new TextEncoder().encode(`${JSON.stringify({ updates }, null, 2)}\n`);
  let binary = "";
  // Avoid spreading a large array into a function call in Workers.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  const payload = {
    message: `Update Centre: ${action} (${new Date().toISOString().slice(0, 10)})`,
    content: btoa(binary),
    branch: config.branch
  };
  if (sha) payload.sha = sha;

  const response = await githubRequest(url, config.token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    if (response.status === 409 || response.status === 422) {
      throw new Error(`GitHub rejected the write (HTTP ${response.status}). The file may have changed simultaneously; reload the updates and try again. ${detail}`);
    }
    throw new Error(`GitHub could not save ${config.path} (HTTP ${response.status}). Check token permissions, repository, branch and file path. ${detail}`);
  }
  return response.json();
}

function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return json(request, { error: "Missing ADMIN_PASSWORD secret in Cloudflare Worker settings." }, 500);
  if (!isAuthorized(request, env)) return json(request, { error: "Admin authentication failed. Enter the correct admin password." }, 401);
  return null;
}

async function handlePublish(request, env) {
  const authError = requireAdmin(request, env);
  if (authError) return authError;

  const input = await parseJsonRequest(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(request, { error: "Request body must be a JSON object." }, 400);
  const valid = validateUpdate(input);
  if (valid.error) return json(request, { error: valid.error }, 400);

  try {
    const current = await readUpdates(env);
    const update = {
      id: `published-${Date.now()}-${crypto.randomUUID()}`,
      keyword: valid.keyword,
      note: valid.note,
      category: valid.category,
      ...(valid.category === "custom" ? { categoryLabel: valid.categoryLabel } : {}),
      publishedDate: validDate(input.publishedDate, new Date().toISOString().slice(0, 10))
    };
    const updates = [...current.updates, update];
    await writeUpdates(env, updates, current.sha, current.config, "publish update");
    return json(request, { ok: true, update, count: updates.length }, 201);
  } catch (error) {
    return json(request, { error: error.message || "Could not publish update." }, 502);
  }
}

async function handleEditDelete(request, env, path) {
  const authError = requireAdmin(request, env);
  if (authError) return authError;

  const input = await parseJsonRequest(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(request, { error: "Request body must be a JSON object." }, 400);
  const id = String(input.id || "").trim();
  if (!id || id.length > 200) return json(request, { error: "A valid update id is required." }, 400);

  try {
    const current = await readUpdates(env);
    const index = current.updates.findIndex(item => item && String(item.id) === id);
    if (index < 0) return json(request, { error: "Update not found. Refresh the list and try again." }, 404);

    let updates;
    if (path === "/delete") {
      updates = current.updates.filter(item => !item || String(item.id) !== id);
    } else {
      const valid = validateUpdate(input);
      if (valid.error) return json(request, { error: valid.error }, 400);
      const old = current.updates[index];
      const edited = {
        ...old,
        keyword: valid.keyword,
        note: valid.note,
        category: valid.category,
        publishedDate: validDate(input.publishedDate, old.publishedDate || new Date().toISOString().slice(0, 10))
      };
      if (valid.category === "custom") edited.categoryLabel = valid.categoryLabel;
      else delete edited.categoryLabel;
      updates = current.updates.slice();
      updates[index] = edited;
    }

    await writeUpdates(env, updates, current.sha, current.config, path === "/delete" ? "delete update" : "edit update");
    return json(request, { ok: true, updates, count: updates.length });
  } catch (error) {
    return json(request, { error: error.message || "Could not save the requested change." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin");

    if (origin && origin !== SITE_ORIGIN) {
      return new Response(JSON.stringify({ error: "Origin not allowed." }), {
        status: 403,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: responseHeaders(request) });
    }

    if (path === "/sheet-data" && request.method === "GET") {
      try {
        const source = "https://sheet.zohopublic.in/sheet/published/dgklm0af687d826af43d683efc73741ee946b?download=xlsx";
        const upstream = await fetch(source, { headers: { "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream;q=0.9, */*;q=0.8" }, cf: { cacheTtl: 0, cacheEverything: false } });
        if (!upstream.ok) return json(request, { error: `Zoho download returned HTTP ${upstream.status}. Check the published downloadable link.` }, 502);
        const bytes = await upstream.arrayBuffer();
        if (bytes.byteLength < 8) return json(request, { error: "Zoho returned an empty file instead of an XLSX workbook." }, 502);
        const headers = new Headers({
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "inline; filename=zoho-update-centre.xlsx",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Vary": "Origin",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        });
        if (origin === SITE_ORIGIN) headers.set("Access-Control-Allow-Origin", SITE_ORIGIN);
        return new Response(bytes, { status: 200, headers });
      } catch (error) {
        return json(request, { error: error.message || "Could not fetch the Zoho workbook." }, 502);
      }
    }

    if (path === "/health" && request.method === "GET") return json(request, { ok: true, service: "Furdeco Update Centre Worker" });
    if (path === "/" && request.method === "GET") {
      return json(request, { ok: true, service: "Furdeco Update Centre Worker", endpoints: ["GET /health", "GET /updates", "POST /admin-login", "POST /publish", "POST /edit", "POST /delete"] });
    }

    if (path === "/updates" && request.method === "GET") {
      try {
        const { updates } = await readUpdates(env);
        return json(request, { updates });
      } catch (error) {
        return json(request, { error: error.message || "Could not load updates." }, 502);
      }
    }

    if (path === "/admin-login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json(request, { error: "Missing ADMIN_PASSWORD secret in Cloudflare Worker settings." }, 500);
      const input = await parseJsonRequest(request);
      if (!input || typeof input !== "object") return json(request, { error: "Request body must be valid JSON." }, 400);
      const email = String(input.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@furdeco\.in$/.test(email)) return json(request, { error: "Use a work email ending in @furdeco.in." }, 400);
      if (!safeEqual(String(input.password || ""), env.ADMIN_PASSWORD)) return json(request, { error: "Incorrect admin password." }, 401);
      return json(request, { ok: true });
    }

    if (request.method === "POST" && path === "/publish") return handlePublish(request, env);
    if (request.method === "POST" && (path === "/edit" || path === "/delete")) return handleEditDelete(request, env, path);
    return json(request, { error: "Route not found." }, 404);
  }
};
