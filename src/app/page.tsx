"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const createRoom = useCallback(() => {
    const roomCode = String(Math.floor(1000 + Math.random() * 9000));
    router.push(`/room?id=${roomCode}`);
  }, [router]);

  const joinRoom = useCallback(() => {
    const trimmed = code.trim();
    if (!/^\d{4}$/.test(trimmed)) {
      setError("Enter a valid 4-digit code");
      return;
    }
    router.push(`/room?id=${trimmed}`);
  }, [code, router]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center max-w-[400px] w-[90%]">
        <h1 className="text-[2.5rem] font-bold mb-1 text-dimle-accent">
          Dimle
        </h1>
        <p className="text-dimle-text-muted mb-10 text-[0.95rem]">
          Ephemeral rooms. No accounts. No history.
        </p>
        <div className="bg-dimle-card border border-dimle-border rounded-2xl p-8 mb-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <button
            onClick={createRoom}
            className="w-full py-3.5 rounded-xl font-semibold text-white bg-dimle-accent hover:bg-dimle-accent-dark transition-colors"
          >
            Create Room
          </button>
          <div className="text-dimle-text-muted my-6 text-sm">
            — or join an existing room —
          </div>
          <input
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
            placeholder="4-digit code"
            maxLength={4}
            inputMode="numeric"
            className="w-full py-3.5 px-4 border border-dimle-border rounded-xl bg-dimle-surface text-dimle-text-primary text-lg text-center tracking-[0.5rem] mb-3 outline-none focus:border-dimle-accent focus:ring-2 focus:ring-dimle-accent-light placeholder:tracking-normal placeholder:text-dimle-text-muted transition-colors"
          />
          <button
            onClick={joinRoom}
            className="w-full py-3.5 rounded-xl font-semibold text-dimle-text-primary bg-dimle-surface border border-dimle-border hover:bg-dimle-border transition-colors"
          >
            Join Room
          </button>
          {error && (
            <p className="text-red-500 text-sm mt-2">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
