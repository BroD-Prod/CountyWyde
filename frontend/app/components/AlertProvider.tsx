'use client';

import {
    createContext,
    ReactNode,
    useCallback,
    useContext,
    useMemo,
    useState,
} from 'react';

type AlertVariant = 'info' | 'success' | 'error';

type AlertItem = {
    id: number;
    message: string;
    variant: AlertVariant;
    isFading: boolean;
};

type AlertContextValue = {
    showAlert: (message: string, variant?: AlertVariant, durationMs?: number) => void;
    dismissAlert: (id: number) => void;
};

const AlertContext = createContext<AlertContextValue | null>(null);
const AUTO_DISMISS_MS = 5000;
const FADE_OUT_MS = 300;

function variantClasses(variant: AlertVariant): string {
    if (variant === 'success') {
        return 'border-emerald-300 bg-emerald-50 text-emerald-900';
    }

    if (variant === 'error') {
        return 'border-red-300 bg-red-50 text-red-900';
    }

    return 'border-blue-300 bg-blue-50 text-blue-900';
}

export default function AlertProvider({ children }: { children: ReactNode }) {
    const [alerts, setAlerts] = useState<AlertItem[]>([]);

    const dismissAlert = useCallback((id: number) => {
        setAlerts((prev) =>
            prev.map((alert) =>
                alert.id === id ? { ...alert, isFading: true } : alert
            )
        );

        setTimeout(() => {
            setAlerts((prev) => prev.filter((alert) => alert.id !== id));
        }, FADE_OUT_MS);
    }, []);

    const showAlert = useCallback(
        (message: string, variant: AlertVariant = 'info', durationMs = AUTO_DISMISS_MS) => {
            const id = Date.now() + Math.floor(Math.random() * 1000);
            setAlerts((prev) => [...prev, { id, message, variant, isFading: false }]);

            if (durationMs > 0) {
                setTimeout(() => {
                    dismissAlert(id);
                }, durationMs);
            }
        },
        [dismissAlert]
    );

    const value = useMemo(
        () => ({
            showAlert,
            dismissAlert,
        }),
        [showAlert, dismissAlert]
    );

    return (
        <AlertContext.Provider value={value}>
            {children}
            <div className="pointer-events-none fixed right-4 top-20 z-50 flex w-80 max-w-full flex-col gap-2">
                {alerts.map((alert) => (
                    <div
                        key={alert.id}
                        className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-md transition-opacity duration-500 ${alert.isFading ? 'opacity-0' : 'opacity-100'} ${variantClasses(alert.variant)}`}
                        role="status"
                        aria-live="polite"
                    >
                        <div className="flex items-start justify-between gap-2">
                            <p>{alert.message}</p>
                            <button
                                type="button"
                                onClick={() => dismissAlert(alert.id)}
                                className="rounded px-2 py-0.5 text-xs font-medium hover:bg-black/10"
                                aria-label="Dismiss notification"
                            >
                                x
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </AlertContext.Provider>
    );
}

export function useAlert(): AlertContextValue {
    const context = useContext(AlertContext);
    if (!context) {
        throw new Error('useAlert must be used within AlertProvider');
    }

    return context;
}
