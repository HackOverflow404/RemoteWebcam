"use client";
import React, { useRef } from "react";

interface CodeInputProps {
    code: string[];
    setCode: React.Dispatch<React.SetStateAction<string[]>>;
    onSubmit?: () => void;
}

const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Driven by onChange rather than keydown: Android virtual keyboards report
// key "Unidentified" on keydown, so keydown-only handling ignored typing there.
export default function CodeInput({ code, setCode, onSubmit }: CodeInputProps) {
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
    const focus = (i: number) => inputRefs.current[Math.max(0, Math.min(code.length - 1, i))]?.focus();

    // Write `chars` starting at `index` (handles typing, paste and autofill).
    const fill = (index: number, chars: string) => {
        if (!chars) return;
        setCode((prev) => {
            const next = [...prev];
            for (let i = 0; i < chars.length && index + i < next.length; i++) next[index + i] = chars[i];
            return next;
        });
        focus(index + chars.length);
    };

    const handleChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
        const value = clean(e.target.value);
        if (!value) {
            setCode((prev) => prev.map((c, i) => (i === index ? "" : c)));
            return;
        }
        // The box already held a character; keep only what was just typed.
        const typed = value.length > 1 && code[index] && value.startsWith(code[index])
            ? value.slice(1)
            : value;
        fill(index, typed);
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Backspace" && !code[index] && index > 0) {
            e.preventDefault();
            setCode((prev) => prev.map((c, i) => (i === index - 1 ? "" : c)));
            focus(index - 1);
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            focus(index - 1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            focus(index + 1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.();
        }
    };

    const handlePaste = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
        e.preventDefault();
        fill(index, clean(e.clipboardData.getData("text")));
    };

    return (
        <div className="w-screen mb-5 flex justify-evenly">
            {code.map((char, index) => (
                <input
                    key={index}
                    ref={(el) => { inputRefs.current[index] = el; }}
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    autoComplete={index === 0 ? "one-time-code" : "off"}
                    spellCheck={false}
                    value={char}
                    onChange={(e) => handleChange(index, e)}
                    onKeyDown={(e) => handleKeyDown(index, e)}
                    onPaste={(e) => handlePaste(index, e)}
                    onFocus={(e) => e.target.select()}
                    aria-label={`Code character ${index + 1}`}
                    className="w-15 h-25 bg-gray-400 rounded-2xl text-center text-black text-4xl font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
            ))}
        </div>
    );
}
