"use client";

import { useState, useRef, useEffect } from "react";
import { generateTextAction } from "@/app/actions/aiAction";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userText = input;
    setInput("");
    
    const userMsg: Message = { id: Date.now().toString(), role: "user", content: userText };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      // Calling your server action
      const reply = await generateTextAction(userText);
      const aiMsg: Message = { id: (Date.now() + 1).toString(), role: "assistant", content: reply };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (error) {
      const errorMsg: Message = { 
        id: (Date.now() + 1).toString(), 
        role: "assistant", 
        content: "Error: AI response generate karne mein masla aaya hai. Please API Key check karein." 
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex flex-col h-screen max-w-4xl mx-auto p-4 md:p-6">
      {/* Top Header */}
      <header className="glass-panel rounded-2xl p-4 mb-4 flex items-center justify-between shadow-2xl border border-purple-500/20">
        <div className="flex items-center space-x-3">
          <div className="w-3 h-3 rounded-full bg-purple-500 animate-pulse shadow-[0_0_12px_#a855f7]"></div>
          <h1 className="font-bold text-xl tracking-wide bg-gradient-to-r from-purple-400 via-pink-400 to-indigo-300 bg-clip-text text-transparent">
            Cinematic AI
          </h1>
        </div>
        <span className="text-xs px-3 py-1 rounded-full bg-purple-950/60 text-purple-300 border border-purple-500/30">
          Made By Hadi
        </span>
      </header>

      {/* Chat Messages Screen */}
      <div className="flex-1 glass-panel rounded-2xl p-4 overflow-y-auto space-y-4 mb-4 shadow-inner">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
            <div className="w-16 h-16 mb-4 rounded-full bg-purple-900/30 border border-purple-500/20 flex items-center justify-center text-purple-400 text-2xl shadow-[0_0_20px_rgba(168,85,247,0.2)]">
              ✨
            </div>
            <p className="text-lg font-medium text-slate-300">Aapki AI Tayyar Hai</p>
            <p className="text-sm text-slate-500 mt-1">Kuch bhi type karke response check karein.</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-5 py-3 text-sm shadow-lg leading-relaxed ${
                  msg.role === "user"
                    ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-br-none"
                    : "bg-slate-800/80 border border-slate-700/60 text-slate-200 rounded-bl-none backdrop-blur-md"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}

        {/* Loading Indicator */}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-800/80 border border-slate-700/60 px-5 py-3 rounded-2xl rounded-bl-none flex items-center space-x-2">
              <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce"></div>
              <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:-0.15s]"></div>
              <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:-0.3s]"></div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Floating Input Form */}
      <form onSubmit={handleSubmit} className="relative">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask cinematic AI..."
          className="w-full glass-input rounded-xl px-5 py-4 pr-14 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500/50 shadow-2xl transition-all"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:hover:bg-purple-600 text-white rounded-lg p-2.5 transition-all shadow-[0_0_15px_rgba(168,85,247,0.4)]"
        >
          <svg
            className="w-4 h-4 transform rotate-90"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        </button>
      </form>
    </main>
  );
}                        