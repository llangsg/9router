import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { getWritableDataDir } from "../utils/writableDataDir.js";

const TTL = 50 * 60 * 1000;
const cache = new Map();
let installing = false;

function runtimeName() {
  return process.platform === "win32" ? "runtime-info.exe" : "runtime-info";
}

function candidates() {
  const home = os.homedir();
  const name = runtimeName();
  const appPaths = [];
  const cliPaths = [];
  if (process.platform === "win32") {
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      appPaths.push(path.join(base, "Programs", "Qoder", "resources", "umid", name));
    }
  } else if (process.platform === "darwin") {
    appPaths.push("/Applications/Qoder.app/Contents/Resources/umid/runtime-info");
    appPaths.push(path.join(home, "Applications", "Qoder.app/Contents/Resources/umid/runtime-info"));
  } else {
    appPaths.push("/opt/Qoder/resources/umid/runtime-info");
    appPaths.push("/opt/qoder/resources/umid/runtime-info");
    appPaths.push("/usr/lib/qoder/resources/umid/runtime-info");
    appPaths.push("/snap/qoder/current/resources/umid/runtime-info");
  }
  const bin = path.join(home, ".qoder", ".bin");
  try {
    for (const entry of fs.readdirSync(bin, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("umid-")) cliPaths.push(path.join(bin, entry.name, name));
      else if (entry.isFile() && entry.name.startsWith("runtime-info")) cliPaths.push(path.join(bin, entry.name));
    }
  } catch {}
  return [
    ...appPaths.map(executable => ({ executable, env: "3" })),
    ...cliPaths.map(executable => ({ executable, env: "3" })),
    { executable: path.join(getWritableDataDir(), "qoder-umid", name), env: "3" },
  ];
}

export function findQoderUmid() {
  for (const candidate of candidates()) {
    try {
      fs.accessSync(candidate.executable, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function runUmid(executable, uid, env = "4") {
  const args = process.platform === "win32" || process.platform === "darwin" ? [env, "--account-stdin"] : [env];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`UMID runtime exited with code ${code}`));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (args.length > 1) child.stdin.end(`${JSON.stringify({ account: uid })}\n`);
    else child.stdin.end();
  });
  const line = output.split(/\r?\n/, 1)[0].trim();
  const data = JSON.parse(line);
  const identity = {
    machineToken: String(data.machineToken || "").trim(),
    machineCode: String(data.machineCode || "").trim(),
    machineType: String(data.machineType || "").trim(),
  };
  if (Object.values(identity).some(value => !value || value.length > 4096)) throw new Error("UMID runtime returned incomplete device identity");
  return identity;
}

export async function getQoderRiskIdentity(uid) {
  if (!uid) throw new Error("Qoder account UID is missing; cannot generate device identity");
  const cached = cache.get(uid);
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  const component = findQoderUmid();
  if (!component) throw new Error("Qoder UMID component is missing. Install Qoder CLI on the gateway host or install the UMID component from the Qoder provider page.");
  const value = await runUmid(component.executable, uid, component.env);
  cache.set(uid, { value, at: Date.now() });
  return value;
}

function parseTarEntry(tar, wanted) {
  let offset = 0;
  let longName = "";
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) break;
    const fullName = longName || (prefix ? `${prefix}/${name}` : name);
    longName = "";
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "L") longName = tar.subarray(start, end).toString().replace(/\0.*$/, "");
    else if ((type === "0" || type === "\0") && fullName === wanted) return tar.subarray(start, end);
  }
  return null;
}

function extractUmid(bundle, machine) {
  const marker = '"f0VMRgIB';
  let offset = 0;
  while ((offset = bundle.indexOf(marker, offset)) !== -1) {
    const start = offset + 1;
    const end = bundle.indexOf('"', start);
    if (end < 0) break;
    const encoded = bundle.slice(start, end);
    const head = Buffer.from(encoded.slice(0, 4096), "base64");
    if (head.length >= 20 && head.readUInt16LE(18) === machine) return Buffer.from(encoded, "base64");
    offset = end + 1;
  }
  return null;
}

export function qoderUmidStatus() {
  const component = findQoderUmid();
  return {
    available: Boolean(component),
    source: component ? (component.executable.includes("qoder-umid") ? "managed" : "existing-installation") : null,
    installSupported: process.platform === "linux" && ["x64", "arm64"].includes(process.arch),
    installing,
  };
}

export async function installQoderUmid() {
  if (!qoderUmidStatus().installSupported) throw new Error("Automatic UMID installation supports Linux x64 and arm64 only. Install Qoder CLI on this host instead.");
  if (installing) throw new Error("Qoder UMID installation is already running");
  installing = true;
  try {
    const metadataResponse = await fetch("https://registry.npmjs.org/@qoder-ai%2fqodercli/latest", { signal: AbortSignal.timeout(15000) });
    if (!metadataResponse.ok) throw new Error(`Qoder CLI package lookup failed (${metadataResponse.status})`);
    const metadata = await metadataResponse.json();
    const tarballUrl = metadata?.dist?.tarball;
    const integrity = metadata?.dist?.integrity || "";
    if (!tarballUrl || !integrity.startsWith("sha512-")) throw new Error("Qoder CLI package metadata is missing its SHA-512 integrity");
    const parsedTarballUrl = new URL(tarballUrl);
    if (parsedTarballUrl.protocol !== "https:" || parsedTarballUrl.hostname !== "registry.npmjs.org") throw new Error("Qoder CLI package metadata returned an untrusted download host");
    const tarballResponse = await fetch(parsedTarballUrl, { signal: AbortSignal.timeout(180000) });
    if (!tarballResponse.ok) throw new Error(`Qoder CLI download failed (${tarballResponse.status})`);
    const archive = Buffer.from(await tarballResponse.arrayBuffer());
    if (archive.length > 100 * 1024 * 1024) throw new Error("Qoder CLI package download exceeds the 100 MiB safety limit");
    const expected = integrity.slice(7);
    const actual = crypto.createHash("sha512").update(archive).digest("base64");
    if (actual !== expected) throw new Error("Qoder CLI package integrity verification failed");
    const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
    const bundle = parseTarEntry(tar, "package/bundle/qodercli.js");
    if (!bundle) throw new Error("Qoder CLI package does not contain its UMID bundle");
    const machine = process.arch === "x64" ? 62 : 183;
    const executable = extractUmid(bundle.toString("utf8"), machine);
    if (!executable) throw new Error(`Qoder UMID binary for ${process.arch} was not found in the official package`);
    const directory = path.join(getWritableDataDir(), "qoder-umid");
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, "runtime-info");
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, executable, { mode: 0o755 });
    try {
      await runUmid(temporary, "install-test", "3");
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`UMID component could not run on this host: ${error.message}`);
    }
    fs.renameSync(temporary, target);
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ version: metadata.version, installedAt: new Date().toISOString() }, null, 2));
    cache.clear();
    return qoderUmidStatus();
  } finally {
    installing = false;
  }
}

export function buildQoderRiskHeaders(identity, uid) {
  const machineIdFile = path.join(getWritableDataDir(), "qoder-machine-id");
  let machineId = "";
  for (const candidate of [
    machineIdFile,
    path.join(os.homedir(), ".qoder-proxy", "machine_id"),
    path.join(os.homedir(), ".qoder", ".auth", "machine_id"),
    path.join(os.homedir(), ".qoder", "machine_id"),
  ]) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)) {
        machineId = value;
        break;
      }
    } catch {}
  }
  if (!machineId) machineId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(machineIdFile), { recursive: true });
  fs.writeFileSync(machineIdFile, machineId, { mode: 0o600 });
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "unknown";
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const hostname = os.hostname().trim().replace(/[^\x21-\x7e ]/g, "-").slice(0, 96);
  let clientVersion = "0.2.5";
  const manifests = process.platform === "darwin"
    ? ["/Applications/Qoder.app/Contents/Resources/build-manifest.json"]
    : process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA || "", "Programs", "Qoder", "resources", "build-manifest.json")]
      : ["/opt/Qoder/resources/build-manifest.json", "/opt/qoder/resources/build-manifest.json"];
  for (const manifest of manifests) {
    try {
      const version = JSON.parse(fs.readFileSync(manifest, "utf8")).productVersion;
      if (typeof version === "string" && version.trim()) {
        clientVersion = version.trim();
        break;
      }
    } catch {}
  }
  return {
    "Cosy-Version": clientVersion,
    "Cosy-MachineOS": `${arch}_${platform}`,
    "Cosy-MachineId": machineId,
    ...(hostname ? { "Cosy-MachineHostname": hostname } : {}),
    "Cosy-MachineToken": identity.machineToken,
    "Cosy-MachineCode": identity.machineCode,
    "Cosy-MachineType": identity.machineType,
  };
}
