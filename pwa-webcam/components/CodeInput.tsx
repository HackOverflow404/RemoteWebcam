"use client";
import React, { useRef } from "react";

interface CodeInputProps {
  code: string[];
  setCode: React.Dispatch<React.SetStateAction<string[]>>;
}

export default function CodeInput({ code, setCode }: CodeInputProps) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Handles backspace behavior
  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      if (code[index]) {
        setCode((prevCode) => {
          const newCode = [...prevCode];
          newCode[index] = "";
          return newCode;
        });
        if (inputRefs.current[index]) {
          inputRefs.current[index].value = "";
        }
        return;
      }

      setCode((prevCode) => {
        const newCode = [...prevCode];
        newCode[index - 1] = "";
        return newCode;
      });
      if (inputRefs.current && inputRefs.current[index - 1]) {
        inputRefs.current[index - 1]!.value = "";
        inputRefs.current[index - 1]!.focus();
      }
      return;
    }

    if (!/^[a-zA-Z0-9]$/.test(event.key)) {
      return;
    }

    setCode((prevCode) => {
      const newCode = [...prevCode];
      newCode[index] = event.key.toUpperCase();
      return newCode;
    });

    if (index < code.length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  return (
    <div className="w-screen mb-5 flex justify-evenly">
      {code.map((char: string, index: number) => (
        <input
          key={index}
          ref={(element: HTMLInputElement | null) => {
            inputRefs.current[index] = element;
          }}
          type="text"
          maxLength={1}
          value={char}
          onKeyDown={(e) => handleKeyDown(index, e)}
          aria-label={`Code input ${index + 1}`}
          onChange={() => {/* Do nothing - onKeyDown handles all logic */}}
          className="w-15 h-25 bg-gray-400 rounded-2xl
                     text-center text-black text-4xl font-bold
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      ))}
    </div>
  );
}