import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import commonEn from './common.en';import commonRu from './common.ru';
import workflowEn from './workflow.en';import workflowRu from './workflow.ru';
import remoteEn from './remote.en';import remoteRu from './remote.ru';
import contextEn from './context.en';import contextRu from './context.ru';
export const localeKey='keryx.hub.locale';
let language='ru';try{const saved=localStorage.getItem(localeKey);if(saved==='ru'||saved==='en')language=saved;}catch{/* Storage may be unavailable; locale fallback remains usable. */}
void i18n.use(initReactI18next).init({resources:{en:{common:commonEn,workflow:workflowEn,context:contextEn,remote:remoteEn},ru:{common:commonRu,workflow:workflowRu,context:contextRu,remote:remoteRu}},lng:language,fallbackLng:'ru',defaultNS:'common',interpolation:{escapeValue:false},returnNull:false});
i18n.on('languageChanged',lang=>{document.documentElement.lang=lang;try{localStorage.setItem(localeKey,lang==='en'?'en':'ru');}catch{/* Language changes still work without storage. */}});
document.documentElement.lang=language;
export default i18n;
