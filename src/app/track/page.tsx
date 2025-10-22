'use client';

import TrackClient from './trackClient';
import { useSearchParams } from 'next/navigation';

export default function TrackPage() {
	const sp = useSearchParams();
	const code = sp.get('v') || '';
	return (
		<div className="w-full h-[calc(100vh-2rem)] p-4">
			<TrackClient code={code} />
		</div>
	);
}
