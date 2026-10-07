"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { isValidRoomId, normalizeRoomId } from "@/lib/room-id";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const createRoom = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create room");

      sessionStorage.setItem(
        `dimle:creation-token:${data.roomId}`,
        data.creationToken
      );
      router.push(`/room?id=${encodeURIComponent(data.roomId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
      setCreating(false);
    }
  }, [router]);
  const joinRoom = useCallback(() => {
    const roomId = normalizeRoomId(code);
    if (!isValidRoomId(roomId)) {
      setError("Enter a room name like apple482");
      return;
    }
    router.push(`/room?id=${encodeURIComponent(roomId)}`);
  }, [code, router]);

  return (
    <div className="home-shell">
      <header className="site-header"><a className="wordmark" href="/">Dimle</a><span className="eyebrow">Chat rooms</span></header>
      <main id="main" className="home-main">
        <section className="hero-copy" aria-labelledby="hero-title">
          <p className="eyebrow hero-kicker">A little space to connect</p>
          <h1 id="hero-title">Just a room.<br />Just us.</h1>
          <p className="hero-description">Chat rooms. No accounts. Room messages are saved.</p>
          <div className="hero-rule" aria-hidden="true"><span>Dimle</span><span>Come together. Keep it simple.</span></div>
        </section>
        <section className="entry-panel" aria-labelledby="entry-title">
          <p className="eyebrow">Your conversation starts here</p>
          <h2 id="entry-title">Make room.</h2>
          <button onClick={createRoom} disabled={creating} aria-busy={creating} className="primary-button">{creating ? "Creating…" : "Create Room"} <span aria-hidden="true">↗</span></button>
          <form onSubmit={(event) => { event.preventDefault(); joinRoom(); }} className="join-form">
            <label htmlFor="room-code">Or join an existing room</label>
            <input id="room-code" type="text" value={code} onChange={(e) => { setCode(e.target.value); setError(""); }} placeholder="apple482" maxLength={16} autoCapitalize="none" autoCorrect="off" autoComplete="off" aria-invalid={!!error} aria-describedby={error ? "code-error" : "room-code-hint"} />
            <p id="room-code-hint" className="form-hint">A short word and 3 digits.</p>
            <button type="submit" className="secondary-button">Join Room <span aria-hidden="true">→</span></button>
            {error && <p id="code-error" role="alert" className="form-error">{error}</p>}
          </form>
        </section>
      </main>
      <footer className="site-footer"><span>Dimle</span><span>No accounts. Just conversation.</span></footer>
    </div>
  );
}
