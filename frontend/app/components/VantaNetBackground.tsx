"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import NET from "vanta/dist/vanta.net.min";

type VantaInstance = {
    destroy: () => void;
};

export default function VantaNetBackground() {
    const vantaRef = useRef<HTMLDivElement | null>(null);
    const effectRef = useRef<VantaInstance | null>(null);

    useEffect(() => {
        const node = vantaRef.current;
        if (!node) {
            return;
        }

        effectRef.current = NET({
            el: node,
            THREE,
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.0,
            minWidth: 200.0,
            scale: 1.0,
            scaleMobile: 1.0,
            backgroundColor: 0x020817,
            color: 0x7dd3fc,
            points: 8.0,
            maxDistance: 18.0,
            spacing: 18.0,
            showDots: true,
            alpha: 0.9,
        });

        return () => {
            effectRef.current?.destroy();
            effectRef.current = null;
        };
    }, []);

    return (
        <div
            ref={vantaRef}
            className="pointer-events-none fixed inset-0 z-0 opacity-90"
            aria-hidden="true"
        />
    );
}
