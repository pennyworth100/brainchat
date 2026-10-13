"use client";
import { useEffect, useRef, useState } from "react";
import { connectPrivateBrowser } from "@/lib/private-browser-client";
import { publicOwnerScope } from "@/lib/public-outbox";

export default function CandidateRecovery() {
  const client = useRef<Awaited<ReturnType<typeof connectPrivateBrowser>> | null>(null);
  const starting = useRef(false);
  const [room, setRoom] = useState(""), [user, setUser] = useState(""), [password, setPassword] = useState("");
  const [draft, setDraft] = useState(""), [phase, setPhase] = useState("offline"), [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [rows, setRows] = useState<readonly { id: number; type: string; username: string; message?: string }[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("dimle:private-owner") ?? "null");
      if (saved) { setRoom(saved.room); setUser(saved.user); }
    } catch { setError("Saved owner unavailable"); }
    const timer = setInterval(() => { if (client.current) setPhase(client.current.status().phase); }, 200);
    return () => { clearInterval(timer); client.current?.close(); };
  }, []);
  const refresh = async () => {
    const current = client.current;
    if (current) { setDraft(current.draft()); setPending(!!await current.pending()); }
  };
  const connect = async () => {
    if (starting.current || client.current) return;
    starting.current = true; setError(""); setPhase("connecting");
    try {
      sessionStorage.setItem("dimle:private-owner", JSON.stringify({ room, user }));
      const scope = "private:" + publicOwnerScope(sessionStorage, room, user);
      client.current = await connectPrivateBrowser(scope, room, user, password, setRows);
      setPassword(""); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed"); setPhase("blocked"); }
    finally { starting.current = false; }
  };
  const act = async (action: "send" | "resolve") => {
    setError("");
    try { await client.current?.[action](); }
    catch (e) { setError(e instanceof Error ? e.message : "Delivery unknown"); }
    finally { await refresh().catch(() => setError("Storage unavailable; sending blocked")); }
  };
  return <main style={{ padding: 24, maxWidth: 720, margin: "auto" }}>
    <h1>Private recovery candidate</h1>
    <p>Text-only validation. Unknown deliveries are retained and never resent.</p>
    <label>Room <input aria-label="Room" value={room} disabled={!!client.current} onChange={e => setRoom(e.target.value)} /></label>
    <label>Name <input aria-label="Name" value={user} disabled={!!client.current} onChange={e => setUser(e.target.value)} /></label>
    <label>Password <input aria-label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} /></label>
    <button onClick={() => void connect()} disabled={!!client.current || phase === "connecting"}>Connect original session</button>
    <p role="status">{phase}</p>
    <p role="alert">{error}</p>
    <p data-testid="pending">{pending ? "UNKNOWN retained" : "No unresolved delivery"}</p>
    <textarea aria-label="Draft" value={draft} disabled={!client.current} onChange={e => {
      try { client.current!.draft(e.target.value); setDraft(e.target.value); }
      catch { setError("Draft storage failed; sending blocked"); client.current?.close(); }
    }} />
    <button disabled={phase !== "ready" || pending} onClick={() => void act("send")}>Send once</button>
    <button disabled={phase !== "ready"} onClick={() => void act("resolve")}>Resolve saved delivery</button>
    <ul>{rows.map(row => <li key={row.id} data-message-id={row.id}>{row.username}: {row.message ?? "[" + row.type + "]"}</li>)}</ul>
  </main>;
}

