import type { ReactNode } from 'react'
import { ArrowRight, Bell, Cpu, MapPin, ShieldCheck, SlidersHorizontal, VideoCamera } from '@phosphor-icons/react'
import { CameraLocationPanel } from '../components/CameraLocationPanel'
import { GuardPanel } from '../components/GuardPanel'
import { UsbPhonePanel } from '../components/UsbPhonePanel'
import type { GuardsApi } from '../hooks/useGuards'
import type { useUsbPhone } from '../hooks/useUsbPhone'
import type { SiteSettings } from '../lib/site'

export type SettingsSection = 'site' | 'cameras' | 'guards' | 'detection' | 'system'
const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'site', label: 'Site', icon: <MapPin size={18} /> },
  { id: 'cameras', label: 'Cameras', icon: <VideoCamera size={18} /> },
  { id: 'guards', label: 'Guards', icon: <ShieldCheck size={18} /> },
  { id: 'detection', label: 'Detection', icon: <SlidersHorizontal size={18} /> },
  { id: 'system', label: 'System', icon: <Cpu size={18} /> },
]

type Props = {
  section: string | null
  onSection(section: SettingsSection): void
  site: SiteSettings
  onSite(patch: Partial<SiteSettings>): void
  guards: GuardsApi
  usb: ReturnType<typeof useUsbPhone>
  usbInUse: boolean
  onUseUsb(): void
  onUsbUnlinked(): void
  cameraPicker: ReactNode
  detection: ReactNode
  sound: { enabled: boolean; label: string; notice: string | null; onToggle(enabled: boolean): void; onTest(): void }
  system: { model: string; modelTone: string; analysis: string; facts: { label: string; value: string }[] }
  onRunSetup(): void
}

export function SettingsPage(props: Props) {
  const section = (SECTIONS.some(item => item.id === props.section) ? props.section : 'site') as SettingsSection
  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1 className="reveal">Settings</h1>
          <p className="page-sub reveal" style={{ ['--i' as string]: 1 }}>Your site, cameras, guards and how alerts work.</p>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav reveal" style={{ ['--i' as string]: 2 }} aria-label="Settings sections">
          {SECTIONS.map(item => (
            <button key={item.id} type="button" className={section === item.id ? 'is-active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => props.onSection(item.id)}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body" key={section}>
          {section === 'site' ? <SiteSection {...props} /> : null}
          {section === 'cameras' ? (
            <Section title="Cameras" sub="Where the video comes from. Analysis runs on this Mac.">
              <div className="settings-card">{props.cameraPicker}</div>
              <div className="settings-card"><UsbPhonePanel usb={props.usb} inUse={props.usbInUse} onUse={props.onUseUsb} onUnlinked={props.onUsbUnlinked} idPrefix="settings-" />
                {!props.usb.available ? <p className="quiet">The local NIVRA service is not answering, so USB phones cannot be listed.</p> : null}</div>
            </Section>
          ) : null}
          {section === 'guards' ? (
            <Section title="Guards" sub="Each guard pairs a phone once with a QR. Alerts ring that phone.">
              <div className="settings-card"><GuardPanel guards={props.guards} showLocation={false} /></div>
            </Section>
          ) : null}
          {section === 'detection' ? (
            <Section title="Detection" sub="Models and sensitivity. Every alert still needs a person to check it.">
              <div className="settings-card">{props.detection}</div>
              <div className="settings-card">
                <div className="setting-row">
                  <Bell size={20} />
                  <div><strong>Alert sound</strong><span>{props.sound.label}</span></div>
                  <label className="switch">
                    <input type="checkbox" checked={props.sound.enabled} onChange={event => props.sound.onToggle(event.target.checked)} aria-label="Alert sound" />
                    <span aria-hidden="true" />
                  </label>
                  <button type="button" className="btn btn-quiet" onClick={props.sound.onTest}>Test</button>
                </div>
                {props.sound.notice ? <p className="quiet" role="status">{props.sound.notice}</p> : null}
              </div>
            </Section>
          ) : null}
          {section === 'system' ? (
            <Section title="System" sub="What is running on this Mac right now.">
              <div className="settings-card">
                <div className="setting-row"><span className={`status-dot ${props.system.modelTone}`} aria-hidden="true" /><div><strong>{props.system.model}</strong><span>{props.system.analysis}</span></div></div>
                <dl className="model-facts is-wide">{props.system.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
              </div>
              <div className="settings-card">
                <div className="setting-row">
                  <ShieldCheck size={20} />
                  <div><strong>Guard phones</strong><span>{props.guards.snapshot?.publicUrl ? `Connect through ${props.guards.snapshot.publicUrl.replace(/^https:\/\//, '')}/guard on any network.` : 'Guard phones join the same Wi-Fi as this Mac.'}</span></div>
                </div>
              </div>
              <div className="settings-card">
                <div className="setting-row">
                  <ArrowRight size={20} />
                  <div><strong>Run setup again</strong><span>Walk through site, camera, location, guard and a test alert.</span></div>
                  <button type="button" className="btn btn-quiet" onClick={props.onRunSetup}>Open setup</button>
                </div>
              </div>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="reveal">{title}</h2>
      <p className="page-sub reveal" style={{ ['--i' as string]: 1 }}>{sub}</p>
      <div className="settings-stack reveal" style={{ ['--i' as string]: 2 }}>{children}</div>
    </section>
  )
}

function SiteSection({ site, onSite, guards }: Props) {
  return (
    <Section title="Site" sub="Names appear on every alert a guard receives.">
      <div className="settings-card field-grid">
        <label className="field" htmlFor="site-name">
          <span className="field-label">Site name</span>
          <input id="site-name" value={site.siteName} maxLength={80} placeholder="Main gate, Sector 21" onChange={event => onSite({ siteName: event.target.value })} />
        </label>
        <label className="field" htmlFor="camera-name">
          <span className="field-label">Camera name</span>
          <input id="camera-name" value={site.cameraName} maxLength={60} placeholder="Camera 1" onChange={event => onSite({ cameraName: event.target.value })} />
        </label>
      </div>
      <div className="settings-card"><CameraLocationPanel guards={guards} /></div>
    </Section>
  )
}
