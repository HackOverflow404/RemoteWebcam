"use client";
import React, { useRef } from "react";

interface CodeInputProps {
  code: string[];
  setCode: React.Dispatch<React.SetStateAction<string[]>>;
}

export default function CodeInput({ code, setCode }: CodeInputProps) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    const key = event.key;

    // Only allow alphanumeric keys
    if (/^[a-zA-Z0-9]$/.test(key)) {
      setCode((prevCode) => {
        const newCode = [...prevCode];
        newCode[index] = key.toUpperCase();
        return newCode;
      });

      // Focus next input
      if (index < code.length - 1) {
        setTimeout(() => inputRefs.current[index + 1]?.focus(), 0);
      }

      event.preventDefault(); // Prevent character duplication
    }

    // Handle Backspace
    else if (key === "Backspace") {
      if (code[index]) {
        // Clear current box
        setCode((prevCode) => {
          const newCode = [...prevCode];
          newCode[index] = "";
          return newCode;
        });
      } else if (index > 0) {
        // Move focus back
        setTimeout(() => inputRefs.current[index - 1]?.focus(), 0);
        setCode((prevCode) => {
          const newCode = [...prevCode];
          newCode[index - 1] = "";
          return newCode;
        });
      }

      event.preventDefault();
    }
  };

  return (
    <div className="w-screen mb-5 flex justify-evenly">
      {code.map((char, index) => (
        <input
          key={index}
          ref={(el) => { inputRefs.current[index] = el; }}
          type="text"
          inputMode="text"
          maxLength={1}
          value={char}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onChange={() => {}}
          aria-label={`Code input ${index + 1}`}
          className="w-15 h-25 bg-gray-400 rounded-2xl
                     text-center text-black text-4xl font-bold
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      ))}
    </div>
  );
}