import { SilaBillingApp } from './app';
import '../src/index.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  const app = new SilaBillingApp(rootEl);
  app.mount();
}
