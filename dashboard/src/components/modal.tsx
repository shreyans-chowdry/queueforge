"use client";

import { useEffect, useRef } from "react";

export function Modal({ children, onClose, labelledBy }: {
  children: React.ReactNode;
  onClose: () => void;
  labelledBy: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  return (
    <dialog ref={ref} aria-labelledby={labelledBy} onCancel={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-xl border border-[#2D374E] bg-[#121624] p-0 text-slate-200 shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm">
      {children}
    </dialog>
  );
}
