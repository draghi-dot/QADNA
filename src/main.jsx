import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { RepoProvider } from './context/RepoContext.jsx'

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <RepoProvider>
      <App />
    </RepoProvider>
  </BrowserRouter>,
)
