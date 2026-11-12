// 내장 원격 데스크톱 별도 창 — rdp.html?t=<token>
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { RdpView } from './RdpView'

const token = new URLSearchParams(location.search).get('t') ?? ''
createRoot(document.getElementById('root')!).render(<RdpView token={token} mode="window" />)
