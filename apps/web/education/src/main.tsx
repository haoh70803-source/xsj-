/** Business application entry using the existing Harness token sheets and React atoms. */
import { createRoot } from 'react-dom/client'
import '../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../packages/client/ui-theme/src/styles/focus.css'
import '../../../../packages/client/ui-theme/src/styles/scrollbar.css'
import './styles.css'
import { App } from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('education-workbench: root element missing')
createRoot(root).render(<App />)
