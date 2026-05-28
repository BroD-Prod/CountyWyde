'use client';
import { useState } from "react";
import { useAlert } from "../components/AlertProvider";

const toBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
            resolve(base64);
        };
        reader.onerror = (error) => reject(error);
    });

export default function Upload() {
    const [files, setFiles] = useState<File[]>([]);
    const { showAlert } = useAlert();

    const uploadFile = async () => {
        if (files.length === 0) {
            showAlert('Please select at least one file to upload', 'error');
            return;
        }

        const payloadFiles = await Promise.all(
            files.map(async (file) => ({
                name: file.name,
                type: file.type,
                size: file.size,
                base64: await toBase64(file),
            }))
        );

        const response = await fetch('http://localhost:1337/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
                files: payloadFiles,
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            showAlert(result.error || 'Upload failed', 'error');
            return;
        }

        showAlert(
            `Upload successful: processed ${result.filesProcessed} file(s), added ${result.added} record(s)`,
            'success'
        );
    }

    return (
        <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-2xl">
                <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Uploads</p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-900">Upload Files</h1>
                    <p className="mt-3 text-sm leading-7 text-slate-500">Add county documents for search and retrieval.</p>

                    <form className="mt-6 space-y-4">
                        <input
                            type="file"
                            multiple
                            className="block w-full cursor-pointer rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-black shadow-sm transition file:mr-4 file:rounded-full file:border-0 file:bg-slate-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:border-slate-400"
                            onChange={(e) => setFiles(e.target.files ? Array.from(e.target.files) : [])}
                        />
                    </form>

                    <button onClick={uploadFile} className="mt-6 w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700">
                        Upload Files
                    </button>
                </div>
            </section>
        </main>
    )
}