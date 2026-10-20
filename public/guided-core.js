// Pure, DOM-free logic for the guided (simple) mode. Imported by guided.js in the browser and by tests in Node.

export const STEP_IDS = ['ai', 'business', 'understood', 'posts', 'review', 'publish', 'month'];
export const OPTIONAL_STEPS = new Set(['month']);

// facts: { aiOk, project, understood, jobRunning, draftsWithBody, approvedCount, publishedOrScheduled, copied, monthPlanStarted, monthSkipped }
export function computeSteps(facts) {
  const done = {
    ai: !!facts.aiOk,
    business: !!facts.project,
    understood: !!facts.project && !!facts.understood,
    posts: (facts.draftsWithBody || 0) >= 1,
    review: (facts.approvedCount || 0) >= 1,
    publish: !!facts.publishedOrScheduled || !!facts.copied,
    month: !!facts.monthPlanStarted || !!facts.monthSkipped,
  };
  let currentFound = false;
  const steps = STEP_IDS.map((id) => {
    let status = 'upcoming';
    if (done[id]) status = 'done';
    else if (!currentFound) { status = 'current'; currentFound = true; }
    return { id, status, optional: OPTIONAL_STEPS.has(id) };
  });
  const doneCount = steps.filter((step) => step.status === 'done').length;
  return { steps, doneCount, total: steps.length, current: steps.find((step) => step.status === 'current')?.id || null };
}

export function charStatus(count, limit, lang = 'es') {
  if (!limit) return { ok: true, text: '' };
  const left = limit - count;
  if (left >= 0) return { ok: true, text: lang === 'es' ? 'Cabe perfectamente' : 'Fits perfectly' };
  return { ok: false, text: lang === 'es' ? `Te pasas por ${-left} caracteres` : `Too long by ${-left} characters` };
}

export function formatDuration(seconds, lang = 'es') {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return lang === 'es' ? 'menos de 1 minuto' : 'under 1 minute';
  const m = Math.round(s / 60);
  if (m < 60) return lang === 'es' ? `unos ${m} minutos` : `about ${m} minutes`;
  const h = Math.round(m / 6) / 10;
  return lang === 'es' ? `unas ${h} horas` : `about ${h} hours`;
}

// Turn technical errors into plain words with a suggested fix. Technical text stays available as `details`.
export function friendlyError(raw, lang = 'es') {
  const details = String(raw?.message || raw || '');
  const es = lang === 'es';
  const rules = [
    [/timeout|aborted/i, es ? 'La IA está tardando más de lo normal. Suele pasar la primera vez, cuando se está "despertando".' : 'The AI is taking longer than usual. This often happens the first time while it wakes up.', 'retry'],
    [/LLM request failed|Is Ollama running|fetch failed|ECONNREFUSED/i, es ? 'No conseguimos hablar con tu IA. Puede que esté apagada o mal configurada.' : 'We could not reach your AI. It may be switched off or set up incorrectly.', 'ai'],
    [/401|403|invalid.*key|api key/i, es ? 'La clave de tu IA no ha funcionado. Revisa que la hayas copiado entera, sin espacios.' : 'Your AI key did not work. Check that you copied all of it, without spaces.', 'ai'],
    [/429|rate limit|too many/i, es ? 'Estás pidiendo demasiado y deprisa. Espera un minuto y vuelve a intentarlo.' : 'That was too many requests too fast. Wait a minute and try again.', 'retry'],
    [/already exists|duplicate/i, es ? 'Ya tienes un negocio con esa web. Lo hemos abierto para ti.' : 'You already have a business with that website. We opened it for you.', 'none'],
    [/private|SSRF|blocked/i, es ? 'Esa dirección no se puede leer desde aquí. Prueba con la dirección pública de tu web.' : 'That address cannot be read from here. Try your public website address.', 'none'],
    [/url is required|invalid url/i, es ? 'Escribe la dirección de tu web, por ejemplo https://mitienda.com' : 'Type your website address, for example https://mystore.com', 'none'],
  ];
  for (const [pattern, message, fix] of rules) if (pattern.test(details)) return { message, fix, details };
  return { message: es ? 'Algo no ha salido como esperábamos. Puedes volver a intentarlo.' : 'Something did not go as expected. You can try again.', fix: 'retry', details };
}

export const BANNED_IN_SIMPLE = ['LLM', 'RAG', 'SSRF', 'JSON', 'API', 'GEO', 'token', 'endpoint', 'policy', 'connector', 'webhook', 'Ollama', 'SEO audit', 'embedding'];

// Words that are allowed to name the AI engine only inside the AI-connection help (step 1 sub-flow).
export const ENGINE_COPY_KEYS = new Set(['ai.local.title', 'ai.local.found', 'ai.local.missing', 'ai.local.step1', 'ai.local.step2', 'ai.local.step3']);

export const T = {
  es: {
    'app.name': 'OpenCMO', 'app.tagline': 'Tu departamento de marketing, paso a paso',
    'top.progress': 'Paso {n} de {total}', 'top.advanced': 'Modo avanzado', 'top.lang': 'English', 'top.help': 'Ayuda',
    'plan.title': 'Tu plan, paso a paso', 'plan.intro': 'Haz solo lo que te marcamos ahora. Nada se publica sin tu visto bueno.',
    'plan.done': '{done} de {total} listos', 'plan.time': 'Tiempo aproximado: {time}', 'plan.why': 'Por qué', 'plan.next': 'Después', 'plan.reopen': 'Ver de nuevo', 'plan.optional': 'Opcional',
    'step.ai.title': 'Conecta la inteligencia artificial', 'step.ai.short': 'Conectar la IA',
    'step.ai.why': 'Es el "cerebro" que escribirá tus textos. Sin ella no podemos empezar.', 'step.ai.time': '2 minutos', 'step.ai.next': 'Te pediremos la dirección de tu web.',
    'step.business.title': 'Cuéntanos sobre tu negocio', 'step.business.short': 'Tu negocio',
    'step.business.why': 'Leemos tu web para escribir como tú y no inventar cosas sobre tu negocio.', 'step.business.time': '1 minuto', 'step.business.next': 'Te enseñaremos lo que hemos entendido para que lo confirmes.',
    'step.understood.title': 'Comprueba lo que hemos entendido', 'step.understood.short': 'Revisar resumen',
    'step.understood.why': 'Si algo está mal aquí, todo lo demás saldrá mal. Corrígelo ahora y listo.', 'step.understood.time': '1 minuto', 'step.understood.next': 'Prepararemos tus primeros 5 textos.',
    'step.posts.title': 'Preparando tus primeros textos', 'step.posts.short': 'Primeros textos',
    'step.posts.why': 'Así ves enseguida cómo sería trabajar con OpenCMO.', 'step.posts.time': '{time}', 'step.posts.next': 'Los revisarás de uno en uno.',
    'step.review.title': 'Revisa y aprueba tus textos', 'step.review.short': 'Revisar textos',
    'step.review.why': 'Tú decides qué sale. Puedes cambiar el tono o pedir otra versión.', 'step.review.time': '5 minutos', 'step.review.next': 'Te diremos cómo publicarlos.',
    'step.publish.title': 'Publica o copia tu primer texto', 'step.publish.short': 'Publicar',
    'step.publish.why': 'Un texto sin publicar no trae clientes. Te enseñamos cómo hacerlo en cada red.', 'step.publish.time': '2 minutos', 'step.publish.next': 'Puedes preparar todo el mes de golpe.',
    'step.month.title': 'Prepara todo tu mes', 'step.month.short': 'Plan del mes',
    'step.month.why': 'Un calendario con textos para cada día evita el "¿qué publico hoy?".', 'step.month.time': '{time} (en segundo plano)', 'step.month.next': 'Irás aprobando textos cuando te venga bien.',
    'btn.next': 'Continuar', 'btn.back': 'Atrás', 'btn.skip': 'Saltar', 'btn.retry': 'Reintentar', 'btn.test': 'Probar que funciona', 'btn.checkAgain': 'Comprobar de nuevo', 'btn.copy': 'Copiar texto', 'btn.copied': '¡Copiado!',
    'btn.approve': 'Aprobar', 'btn.change': 'Cambiar', 'btn.skipPost': 'Ver otro', 'btn.discard': 'Descartar', 'btn.save': 'Guardar', 'btn.confirm': 'Sí, es correcto', 'btn.edit': 'Corregir',
    'btn.start': 'Empezar', 'btn.createPlan': 'Preparar mi mes', 'btn.addCalendar': 'Añadir al calendario para mañana', 'btn.tryDemo': 'Probar primero con un negocio de ejemplo', 'btn.useThis': 'Usar esta IA', 'btn.cancel': 'Cancelar',
    'ai.choose': 'Elige cómo quieres conectar la IA', 'ai.recommended': 'Recomendado',
    'ai.local.title': 'Gratis y privada, en tu ordenador', 'ai.local.found': 'Hemos encontrado una IA en tu ordenador: {model}.', 'ai.local.missing': 'Todavía no tienes una IA instalada en tu ordenador. Son 3 pasos:',
    'ai.local.step1': '1. Descarga e instala el programa desde ollama.com (es gratis).', 'ai.local.step2': '2. Abre la aplicación "Terminal" y pega este comando. Descargará la IA (unos 5 GB):', 'ai.local.step3': '3. Cuando acabe, vuelve aquí y pulsa "Comprobar de nuevo".',
    'ai.local.needs': 'Necesitas unos 16 GB de memoria RAM. Es más lenta que la opción online.',
    'ai.online.title': 'Online (la más rápida)', 'ai.online.help': 'Usas el servicio de una empresa de IA. Pagas por uso, normalmente céntimos. Tus textos viajan a sus servidores.',
    'ai.online.provider': '¿Qué servicio vas a usar?', 'ai.online.key': 'Pega aquí tu clave', 'ai.online.where': 'Dónde consigo la clave',
    'ai.online.s1': '1. Crea una cuenta en {site}.', 'ai.online.s2': '2. Entra en "{section}" y crea una clave nueva.', 'ai.online.s3': '3. Cópiala y pégala arriba. Empieza por "{prefix}".',
    'ai.demo.title': 'Solo quiero verlo funcionar', 'ai.demo.help': 'Te enseñamos un negocio de ejemplo con textos ya preparados. Sin instalar nada.',
    'ai.testing': 'Comprobando… la primera vez puede tardar 1-2 minutos mientras la IA se "despierta".', 'ai.ok': '¡Perfecto! La IA responde.', 'ai.fail': 'No ha funcionado.',
    'biz.url': 'Dirección de tu web', 'biz.urlHint': 'Por ejemplo: https://mitienda.com', 'biz.noSite': 'No tengo web', 'biz.name': 'Nombre de tu negocio', 'biz.desc': '¿A qué te dedicas? (2-3 frases)', 'biz.lang': 'Idioma de tus textos',
    'biz.reading': 'Leyendo tu web…', 'biz.readingHelp': 'Esto tarda menos de un minuto. No salimos de tu ordenador.',
    'und.title.what': 'Lo que vendes', 'und.title.who': 'A quién se lo vendes', 'und.title.tone': 'Cómo hablas', 'und.hint': 'Esto lo hemos deducido de tu web. Si algo no es correcto, pulsa "Corregir".',
    'posts.working': 'Estamos trabajando para ti', 'posts.m1': 'Revisando tu web…', 'posts.m2': 'Pensando tu estrategia…', 'posts.m3': 'Escribiendo texto {n} de {total}…', 'posts.ready': '¡Tus primeros textos están listos!', 'posts.leave': 'Puedes cerrar esta pestaña: seguiremos trabajando.',
    'review.of': 'Texto {n} de {total}', 'review.where': 'Para {channel}', 'review.why': 'Por qué este texto', 'review.rewrite': 'Reescribiendo… unos 40 segundos',
    'review.shorter': 'Más corto', 'review.friendlier': 'Más cercano', 'review.pro': 'Más profesional', 'review.other': 'Otra idea', 'review.empty': 'No quedan textos por revisar. ¡Buen trabajo!', 'review.approvedN': '{n} aprobados',
    'pub.title': 'Tus textos aprobados', 'pub.how': 'Cómo publicarlo', 'pub.empty': 'Aprueba al menos un texto para poder publicarlo.',
    'how.linkedin': 'Abre LinkedIn, pulsa "Empezar publicación", pega el texto y pulsa "Publicar".', 'how.x': 'Abre X, pulsa "Postear", pega el texto y pulsa "Postear".', 'how.blog': 'Pega el texto en tu web (WordPress, Wix, Shopify…) como entrada nueva y publícala.', 'how.newsletter': 'Pega el texto en tu herramienta de correo (Mailchimp, Brevo…) y envía una prueba antes.', 'how.other': 'Pega el texto donde lo vayas a usar.',
    'month.help': 'Prepararemos 30 textos repartidos por tus redes. Los verás aparecer poco a poco y los aprobarás cuando quieras.', 'month.estimate': 'En tu ordenador tardará {time}. Con IA online, unos minutos.', 'month.started': 'Ya estamos preparando tu mes. Mira el avance arriba.', 'month.done': 'Plan del mes preparado',
    'done.title': '¡Lo has conseguido!', 'done.text': 'Ya tienes tu negocio entendido, textos aprobados y un plan. Vuelve cada semana: solo tendrás que revisar y aprobar.', 'done.first': '¡Primer texto aprobado! Siguiente paso: publícalo o añádelo al calendario.',
    'safe.note': 'Nada se publica sin que tú lo apruebes.', 'help.title': '¿Necesitas ayuda?', 'tech.details': 'Detalles técnicos', 'loading': 'Cargando…', 'channel.linkedin': 'LinkedIn', 'channel.x': 'X (Twitter)', 'channel.blog': 'tu blog', 'channel.newsletter': 'tu newsletter', 'channel.other': 'otro canal',
    'demo.badge': 'EJEMPLO', 'demo.banner': 'Estás viendo un negocio de ejemplo. Cuando quieras, empieza con el tuyo.', 'demo.leave': 'Empezar con mi negocio',
    'h.ai': 'La IA es el programa que escribe los textos por ti. Puede funcionar en tu ordenador o en internet.', 'h.draft': 'Un "borrador" es un texto preparado que todavía no se ha publicado.', 'h.approve': 'Aprobar significa que das tu visto bueno. No se publica solo: tú decides cuándo y dónde.', 'h.calendar': 'El calendario te recuerda qué publicar cada día.',
  },
  en: {
    'app.name': 'OpenCMO', 'app.tagline': 'Your marketing department, step by step',
    'top.progress': 'Step {n} of {total}', 'top.advanced': 'Advanced mode', 'top.lang': 'Español', 'top.help': 'Help',
    'plan.title': 'Your plan, step by step', 'plan.intro': 'Just do what we show you now. Nothing is posted without your OK.',
    'plan.done': '{done} of {total} done', 'plan.time': 'Approximate time: {time}', 'plan.why': 'Why', 'plan.next': 'Then', 'plan.reopen': 'View again', 'plan.optional': 'Optional',
    'step.ai.title': 'Connect the artificial intelligence', 'step.ai.short': 'Connect the AI',
    'step.ai.why': 'It is the "brain" that will write your texts. We cannot start without it.', 'step.ai.time': '2 minutes', 'step.ai.next': 'We will ask for your website address.',
    'step.business.title': 'Tell us about your business', 'step.business.short': 'Your business',
    'step.business.why': 'We read your website so we write like you and do not invent things about your business.', 'step.business.time': '1 minute', 'step.business.next': 'We will show what we understood so you can confirm it.',
    'step.understood.title': 'Check what we understood', 'step.understood.short': 'Check summary',
    'step.understood.why': 'If something is wrong here, everything else will be wrong. Fix it now and you are done.', 'step.understood.time': '1 minute', 'step.understood.next': 'We will prepare your first 5 texts.',
    'step.posts.title': 'Preparing your first texts', 'step.posts.short': 'First texts',
    'step.posts.why': 'This is how you see right away what working with OpenCMO feels like.', 'step.posts.time': '{time}', 'step.posts.next': 'You will review them one by one.',
    'step.review.title': 'Review and approve your texts', 'step.review.short': 'Review texts',
    'step.review.why': 'You decide what goes out. You can change the tone or ask for another version.', 'step.review.time': '5 minutes', 'step.review.next': 'We will show you how to publish them.',
    'step.publish.title': 'Publish or copy your first text', 'step.publish.short': 'Publish',
    'step.publish.why': 'A text that is not published brings no customers. We show you how on each network.', 'step.publish.time': '2 minutes', 'step.publish.next': 'You can prepare the whole month at once.',
    'step.month.title': 'Prepare your whole month', 'step.month.short': 'Month plan',
    'step.month.why': 'A calendar with a text for each day ends the "what do I post today?" problem.', 'step.month.time': '{time} (in the background)', 'step.month.next': 'You approve texts whenever it suits you.',
    'btn.next': 'Continue', 'btn.back': 'Back', 'btn.skip': 'Skip', 'btn.retry': 'Try again', 'btn.test': 'Test that it works', 'btn.checkAgain': 'Check again', 'btn.copy': 'Copy text', 'btn.copied': 'Copied!',
    'btn.approve': 'Approve', 'btn.change': 'Change', 'btn.skipPost': 'See another', 'btn.discard': 'Discard', 'btn.save': 'Save', 'btn.confirm': 'Yes, that is right', 'btn.edit': 'Fix it',
    'btn.start': 'Start', 'btn.createPlan': 'Prepare my month', 'btn.addCalendar': 'Add to the calendar for tomorrow', 'btn.tryDemo': 'Try a sample business first', 'btn.useThis': 'Use this AI', 'btn.cancel': 'Cancel',
    'ai.choose': 'Choose how to connect the AI', 'ai.recommended': 'Recommended',
    'ai.local.title': 'Free and private, on your computer', 'ai.local.found': 'We found an AI on your computer: {model}.', 'ai.local.missing': 'You do not have an AI installed on your computer yet. It takes 3 steps:',
    'ai.local.step1': '1. Download and install the program from ollama.com (it is free).', 'ai.local.step2': '2. Open the "Terminal" app and paste this command. It downloads the AI (about 5 GB):', 'ai.local.step3': '3. When it finishes, come back here and press "Check again".',
    'ai.local.needs': 'You need about 16 GB of RAM. It is slower than the online option.',
    'ai.online.title': 'Online (the fastest)', 'ai.online.help': 'You use an AI company\'s service. You pay per use, usually cents. Your texts travel to their servers.',
    'ai.online.provider': 'Which service will you use?', 'ai.online.key': 'Paste your key here', 'ai.online.where': 'Where do I get the key',
    'ai.online.s1': '1. Create an account at {site}.', 'ai.online.s2': '2. Go to "{section}" and create a new key.', 'ai.online.s3': '3. Copy it and paste it above. It starts with "{prefix}".',
    'ai.demo.title': 'I just want to see it working', 'ai.demo.help': 'We show you a sample business with texts already prepared. Nothing to install.',
    'ai.testing': 'Checking… the first time it can take 1-2 minutes while the AI "wakes up".', 'ai.ok': 'Perfect! The AI answers.', 'ai.fail': 'It did not work.',
    'biz.url': 'Your website address', 'biz.urlHint': 'For example: https://mystore.com', 'biz.noSite': 'I do not have a website', 'biz.name': 'Your business name', 'biz.desc': 'What do you do? (2-3 sentences)', 'biz.lang': 'Language of your texts',
    'biz.reading': 'Reading your website…', 'biz.readingHelp': 'This takes under a minute. Nothing leaves your computer except the page request.',
    'und.title.what': 'What you sell', 'und.title.who': 'Who you sell to', 'und.title.tone': 'How you speak', 'und.hint': 'We worked this out from your website. If something is wrong, press "Fix it".',
    'posts.working': 'We are working for you', 'posts.m1': 'Reading your website…', 'posts.m2': 'Thinking through your strategy…', 'posts.m3': 'Writing text {n} of {total}…', 'posts.ready': 'Your first texts are ready!', 'posts.leave': 'You can close this tab: we will keep working.',
    'review.of': 'Text {n} of {total}', 'review.where': 'For {channel}', 'review.why': 'Why this text', 'review.rewrite': 'Rewriting… about 40 seconds',
    'review.shorter': 'Shorter', 'review.friendlier': 'Friendlier', 'review.pro': 'More professional', 'review.other': 'Another idea', 'review.empty': 'No texts left to review. Great job!', 'review.approvedN': '{n} approved',
    'pub.title': 'Your approved texts', 'pub.how': 'How to post it', 'pub.empty': 'Approve at least one text so you can publish it.',
    'how.linkedin': 'Open LinkedIn, press "Start a post", paste the text and press "Post".', 'how.x': 'Open X, press "Post", paste the text and press "Post".', 'how.blog': 'Paste the text into your site (WordPress, Wix, Shopify…) as a new post and publish it.', 'how.newsletter': 'Paste the text into your email tool (Mailchimp, Brevo…) and send a test first.', 'how.other': 'Paste the text wherever you will use it.',
    'month.help': 'We will prepare 30 texts spread across your networks. You will see them appear little by little and approve them whenever you like.', 'month.estimate': 'On your computer it takes {time}. With an online AI, a few minutes.', 'month.started': 'We are preparing your month. Watch progress at the top.', 'month.done': 'Month plan ready',
    'done.title': 'You did it!', 'done.text': 'You now have your business understood, approved texts and a plan. Come back every week: you will only need to review and approve.', 'done.first': 'First text approved! Next: publish it or add it to the calendar.',
    'safe.note': 'Nothing is posted unless you approve it.', 'help.title': 'Need help?', 'tech.details': 'Technical details', 'loading': 'Loading…', 'channel.linkedin': 'LinkedIn', 'channel.x': 'X (Twitter)', 'channel.blog': 'your blog', 'channel.newsletter': 'your newsletter', 'channel.other': 'another channel',
    'demo.badge': 'SAMPLE', 'demo.banner': 'You are looking at a sample business. Start with your own whenever you like.', 'demo.leave': 'Start with my business',
    'h.ai': 'The AI is the program that writes the texts for you. It can run on your computer or on the internet.', 'h.draft': 'A "draft" is a prepared text that has not been published yet.', 'h.approve': 'Approving means you give your OK. It is not posted by itself: you decide when and where.', 'h.calendar': 'The calendar reminds you what to post each day.',
  },
};

export const PROVIDERS = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', site: 'platform.openai.com', section: 'API keys', prefix: 'sk-' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', site: 'openrouter.ai', section: 'Keys', prefix: 'sk-or-' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', site: 'console.groq.com', section: 'API Keys', prefix: 'gsk_' },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', site: 'aistudio.google.com', section: 'Get API key', prefix: 'AIza' },
};

export function translate(lang, key, vars = {}) {
  const raw = T[lang]?.[key] ?? T.en[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_match, name) => (vars[name] ?? `{${name}}`));
}

export function channelKey(channel) { return ['linkedin', 'x', 'blog', 'newsletter'].includes(channel) ? channel : 'other'; }
