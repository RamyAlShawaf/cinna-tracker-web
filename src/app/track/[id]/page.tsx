'use client';

import TrackClient from '../trackClient';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function TrackByIdPage() {
	const params = useParams<{ id: string }>();
	const [mounted, setMounted] = useState(false);
	useEffect(() => { setMounted(true); }, []);
	if (!mounted) return null;
	const code = (params?.id || '').toString();
	return (
		<div className="fixed inset-x-0" style={{ top: '4rem', bottom: 0 }}>
			<TrackClient code={code} showInput={false} />
		</div>
	);
}


