"use client";
import { useEffect } from "react";

// Anima elementos com [data-reveal] quando entram na tela. Sem JS, tudo aparece normalmente.
export function RevealOnScroll() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("js-reveal");
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("is-visible")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    els.forEach((e) => io.observe(e));
    return () => { io.disconnect(); };
  }, []);
  return null;
}
