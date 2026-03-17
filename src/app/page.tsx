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
        <h1 className="text-[2.5rem] font-bold mb-1 bg-gradient-to-br from-dimle-purple to-dimle-cyan bg-clip-text text-transparent">
          Dimle
        </h1>
        <p className="text-gray-500 mb-10 text-[0.95rem]">
          Ephemeral rooms. No accounts. No history.
        </p>
        <div className="bg-dimle-card border border-dimle-border rounded-xl p-8 mb-4">
          <button
            onClick={createRoom}
            className="w-full py-3.5 rounded-lg font-semibold text-white bg-gradient-to-br from-dimle-purple to-dimle-purple-dark hover:opacity-85 transition-opacity"
          >
            Create Room
          </button>
          <div className="text-gray-500 my-6 text-sm">
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
            className="w-full py-3.5 px-4 border border-dimle-border-hover rounded-lg bg-dimle-bg text-gray-200 text-lg text-center tracking-[0.5rem] mb-3 outline-none focus:border-dimle-purple placeholder:tracking-normal placeholder:text-gray-600"
          />
          <button
            onClick={joinRoom}
            className="w-full py-3.5 rounded-lg font-semibold text-gray-200 bg-dimle-border border border-dimle-border-hover hover:opacity-85 transition-opacity"
          >
            Join Room
          </button>
          {error && (
            <p className="text-red-400 text-sm mt-2">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
