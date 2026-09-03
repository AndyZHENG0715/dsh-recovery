// dsh-recovery browser half (P2): render probe + settings status card.
// Registers one `settings.section` entry (id: dsh-recovery) and reports page
// render state to the host loopback route /api/dsh-recovery/report-render.
window.__ModuleLoader__.load({
	id: 'dsh-recovery-plugin',
	factory: (require) => {
		const React = require('react')
		const { useState, useEffect, createElement: h } = React
		const NS = 'dsh-recovery-plugin'

		const post = (path, payload) => {
			try {
				fetch(path, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload ?? {}),
					keepalive: true
				}).catch(() => {})
			} catch {}
		}
		const report = (ok, error) => {
			if (typeof window === 'undefined') return
			post('/api/dsh-recovery/report-render', { ok, error })
		}
		const row = (label, value, color) => h('div', {
			style: {
				display: 'flex', justifyContent: 'space-between', gap: '12px',
				padding: '8px 12px', borderRadius: '10px',
				background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
				fontSize: '13px', lineHeight: '20px'
			}
		}, h('span', { style: { opacity: 0.72 } }, label), h('span', { style: { color: color ?? undefined, fontWeight: 500 } }, String(value)))
		const badge = (ok) => h('span', {
			style: {
				display: 'inline-block', padding: '1px 8px', borderRadius: '999px',
				fontSize: '12px', fontWeight: 600,
				color: ok ? 'var(--dsw-alias-success, #22c55e)' : 'var(--dsw-alias-danger, #ef4444)',
				background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'
			}
		}, ok ? 'healthy' : 'attention')

		function StatusCard(_props) {
			const [status, setStatus] = useState(null)
			useEffect(() => {
				let dead = false
				const load = async () => {
					try {
						const res = await fetch('/api/dsh-recovery/status')
						const json = await res.json()
						if (!dead) setStatus(json)
					} catch {}
				}
				load()
				const timer = setInterval(load, 10000)
				return () => { dead = true; clearInterval(timer) }
			}, [])
			const title = h('div', { style: { fontSize: '16px', fontWeight: 600, marginBottom: '12px' } }, 'dsh-recovery — automatic recovery status')
			if (status === null) return h('div', { style: { padding: '16px' } }, title, h('div', { style: { opacity: 0.6 } }, 'loading…'))
			const quarantined = (status.quarantined ?? []).map((q) => q.id).join(', ') || 'none'
			const healthOk = status.ok === true && status.bootFailures === 0 && quarantined === 'none'
			return h('div', { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' } },
				title,
				row('profile', status.profile, undefined),
				row('mode', status.mode === 'safe' ? 'SAFE MODE' : 'normal', status.mode === 'safe' ? '#f59e0b' : undefined),
				h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px' } }, h('span', { style: { opacity: 0.72, fontSize: '13px' } }, 'health'), badge(healthOk)),
				row('last snapshot', status.lastSnapshot ?? 'unset', undefined),
				row('last good', status.lastGood ?? 'unset', undefined),
				row('boot failures', status.bootFailures ?? 0, status.bootFailures > 0 ? '#f59e0b' : undefined),
				row('quarantined rows', quarantined, undefined),
				row('presets verified', (status.presetVerification ? status.presetVerification.cache.filter((v) => v.ok).length + '/' + status.presetVerification.total + ' ok' : 'n/a'), undefined),
				row('client render', status.clientRender ? (status.clientRender.ok ? 'ok' : 'failed: ' + (status.clientRender.error ?? '')) : 'not reported', status.clientRender && !status.clientRender.ok ? '#ef4444' : undefined),
				row('install guard', status.installSnapshotGuard ? 'armed (Tier A+B snapshots)' : 'off', undefined),
				row('heartbeat', status.heartbeat ? new Date(status.heartbeat.at).toLocaleTimeString() : 'none', undefined),
				h('div', { style: { opacity: 0.55, fontSize: '12px', marginTop: '8px' } }, 'undo a quarantined row: dsh-recovery unquarantine --id <id>')
			)
		}

		return {
			name: NS,
			inject: ['slots'],
			apply(ctx) {
				// Render probe: page-level ok signal once the client module
				// graph is live; failures arrive through the global listeners.
				if (typeof window !== 'undefined') {
					window.addEventListener('error', (event) => report(false, String(event?.message ?? event?.error ?? 'window error')))
					window.addEventListener('unhandledrejection', (event) => report(false, String(event?.reason?.message ?? event?.reason ?? 'unhandled rejection')))
					setTimeout(() => report(true), 3000)
				}
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'dsh-recovery',
					order: 90,
					label: () => 'dsh-recovery'
				}, StatusCard))
			}
		}
	}
});
