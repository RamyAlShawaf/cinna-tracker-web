'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function TrackPage() {
	const router = useRouter();
	const [mounted, setMounted] = useState(false);
	const [value, setValue] = useState('');
	useEffect(() => { setMounted(true); }, []);
	if (!mounted) return null;
	return (
		<div className="fixed inset-x-0 flex items-center justify-center" style={{ top: '4rem', bottom: 0 }}>
			<div className="w-full max-w-md">
				<label className="block text-sm mb-2 text-muted">Enter bus code</label>
				<input
					autoFocus
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder="e.g., ONX-102"
					className="input"
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							const code = value.trim();
							if (code) router.push(`/track/${encodeURIComponent(code)}`);
						}
					}}
				/>
			</div>
		</div>
	);
}
