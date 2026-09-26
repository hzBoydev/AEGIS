"use client";

import { useEffect, useRef } from "react";

/**
 * setInterval yang otomatis berhenti saat tab tidak terlihat dan langsung
 * mengejar (fetch sekali) saat tab kembali aktif.
 *
 * Dipakai oleh semua polling REST di UI supaya tidak mengirim request ke
 * backend ketika pengguna membuka tab lain.
 */
export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  enabled: boolean = true
): void {
  const cbRef = useRef(callback);

  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => cbRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    // Jalankan sesegera mungkin, lalu interval selama tab terlihat.
    cbRef.current();
    if (document.visibilityState === "visible") start();

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        cbRef.current(); // mengejar data yang terlewat
        start();
      } else {
        stop();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
