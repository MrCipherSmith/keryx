# Contribution log

Dated decisions of the operator that changed the direction of the article, each with a verbatim quote and its source. Row format: `YYYY-MM-DD · source · «quote» · what changed in the article`.

Quotes are in the language they were written in (Russian). The source of each row is an operator message in the working session, cited as "channel message <id>" with the Telegram message id; transcripts of that session are not part of this repository. Rows after the first twelve are cited as "article draft comment" with the place in the draft and the UTC time, or as "operator session decision". A row is written only where a verbatim quote exists.

2026-09-28 · channel message 170491 · «но и предлагаем решение и проверяем это практически» · The article must not stop at theory and current problems: it proposes a solution and checks it in practice.

2026-09-28 · channel message 170614 · «я предлагаю все-таки делать это на Keryx, то есть другие не упоминать» · One test base only: the practical part is built on Keryx, and no other repositories are mentioned.

2026-09-28 · channel message 170789 · «проект Keryx используется именно как тестовая база» · Keryx is framed as the test base for the theory, not as the subject of the article.

2026-09-28 · channel message 170800 · «один человек или одна команда» · One person or one team covers what used to be split between product and development roles; this is the starting point of the role-blurring framing.

2026-09-28 · channel message 170866 · «не роли, а именно функции» · The framing moves from roles to sets of functions; the question of whether this approach is already described in the literature went into the source check.

2026-10-02 · channel message 177393 · «все задачи, которые сформулированы по улучшению или по внедрению каких-то новых функциональностей они основаны на хотелках и на требованиях человека» · Flows are classified by who started them: most are started by the human, a few by the agent after confirmation; this is why the counts split flows by origin.

2026-10-02 · channel message 177418 · «статья о том как изменяется роль продакт менеджмента и проджект менеджмента в разработке продукта при интеграции и внедрении AI инструментов» · One-sentence statement of the article's subject.

2026-10-02 · channel message 177461 · «мы пишем статью не о том, как мы используем Keryx» · The article is about how the trends change and what was checked; Keryx is the evidence, and the theoretical novelty and the practical part are two separate parts.

2026-10-02 · channel message 177483 · «агент должен сам определять откуда он пришел» · Every new flow records its origin in the effects section; the origin field in the counts comes from this decision.

2026-10-02 · channel message 177497 · «человек выступает в роли менеджера, именно агента уже, а не какого-то продукта» · The human is described as the manager of the agent; the agent's work has to be transparent and controllable through criteria, tasks and statuses.

2026-10-02 · channel message 177672 · «мы можем в первой части вывести тренды, озвучить проблемы, выводы» · The article is split: part 1 gives trends, problems and conclusions; the new methodology and how it will be tested are announced.

2026-10-02 · channel message 177672 · «размытия ролей, проблема авторства» · Role blurring and the problem of authorship become the named focus, in the context of development.

2026-10-02 · article draft comment, аннотация, «письма», 19:46 UTC · «Что за "письма"? слабо соотносится с техническими ролями» · The word «письмо» was replaced by "production of artifacts: requirements, criteria, code, tests, review, releases".

2026-10-02 · article draft comment, аннотация, «сделанное», 19:46 UTC · «сделано» · The wording was accepted.

2026-10-03 · article draft comment, таблица 1, проблема 6, 06:48 UTC · «Очень старый источник, относится ли данная пробелма к ИИ? нужны свежие данные или обоснование и приведение именно к ИИ» · METR 2025 and DORA 2025 were added; Cagan and Kohavi 2009 were moved to the role of baseline.

2026-10-03 · article draft comment, строка автора, 06:53 UTC · «В статье ниже где то Я то есть от моего лица, где то Мы (кто мы?) Я предлагаю акцентировать что статья написана в соавторстве моем и агентов, не на надо постоянно указывать ИИ-агенты, по русски как минимум это звучит не очень - исскуственный интеллект агенты. То есть Я рассказываю - пишу статью, но не скрываю о соавторстве ИИ, (или агента,) То есть где я описываю свой опыт или наблюдения - там я, где блоки о том что мы проанализировали, сделали выводы - там Мы, нужно пройтись по все статье и четко это зафиксировать. В текущем блоке. Оставь Автор, убери слово "в одиночку" , замени ИИ-агенты на ИИ или агенты, не вместе. Исследование и статья подготовлены в соавторстве актора и агентов;» · The rule "I for experience, we for analysis" was applied across the whole text; the authorship block was revised; "AI agents" became "agents".

2026-10-03 · article draft comment, аннотация, 07:02 UTC · «Мне не нравится слово Письма» · The word was dropped from the abstract, the same change as the 2026-10-02 comment on it.

2026-10-03 · article draft comment, §1, описание keryx, 07:06 UTC · «Сходи в https://github.com/MrCipherSmith/keryx посмотри о чем проект, и сформулируй точнее описание - как минимум это проект о управлении, разработке, менеджменте, организации памяти и тп. тебе нужно в теже несколько слов уместить описание (что бы он выглядел сильно и рекламировался в этой статье сам себя)» · The description of keryx was rewritten from its README.

2026-10-03 · article draft comment, §1, роли в команде, 07:09 UTC · «замени на проджект или продукт менеджер, дизайнер,» · The list of roles was changed to project or product manager and designer.

2026-10-03 · article draft comment, §2, 07:13 UTC · «выдели эту часть жирным - или как-то с акцентируй» · The claim "when trying is cheaper than discussing, discussion disappears" was emphasized.

2026-10-03 · article draft comment, §1, роли в команде, 10:47 UTC · «Оставь только дизайнера, продукты у нас вообще не понятно чем занимаются» · Only the designer was kept in the example of role blurring.

2026-10-04 · article draft comment, §2, 04:05 UTC · «Сегодня уже сентябрь 2026, нужно поискать свежие данные» · The industry background was rebuilt on 2025–2026 sources (LinearB, Sonar, DORA, Carta, Stripe).

2026-10-04 · article draft comment, таблица 1, проблема 2, 04:08 UTC · «2010 год? Тогда не было агентов и суть проблемы вряд ли связана с Ии, данные лучше искать и брать ближе к к концу 2026» · Zhou et al., ICSE 2026 was added; Parasuraman & Manzey were kept as the source of the term.

2026-10-04 · article draft comment, таблица 1, проблемы 5 и 6, 04:58 UTC · «В 5 и 6 пунктах так же ссылка до агентную эру. Как соотносится? Нет свежее?» · Sabour et al. 2026 and Wilson et al. 2025 were added; rule adopted: old sources give definitions and baselines.

2026-10-04 · article draft comment, §4, 05:21 UTC · «Не надо таких негативных заключений причем не влияющих. Выше там есть место где в keryx жестко указано что есть рекомендация. Как раз в рамках исследования мы изменили это ведем эксперимент через слепые вопросы. Обнови данные по керикс если нужно в артифактами с данными для статьи» · Negative caveats were removed; the blind mode of the journal is described as part of the study; the keryx figures were updated.

2026-10-04 · article draft comment, §4, 05:23 UTC · «Что это значит? Что мы не нашли или это ведет к тому что мы такой и делаем/сделали. Если второе, то очень не очевидно» · The sentence about tools was rewritten as a bridge to §6.

2026-10-04 · article draft comment, §7, 05:35 UTC · «Я нас заявлено везде 2 недели но по факту будет меньше, 3 часть будет публиковаться примерно 10 октября или раньше. Стоит учесть что со второго октября было сделано очень много и модно анализировать уже через 1-2 дня. Поэтому не ставь четких сроков на 2 часть статьи» · The deadlines for part 2 were removed.

2026-10-04 · article draft comment, §2, 06:46 UTC · «Постоянно одно и тоже слово корпус, хотя оно не очень на слух, явная метка что сгенерировано ии» · The word "корпус" was removed everywhere.

2026-10-04 · article draft comment, §3.1, проблема 2, 06:49 UTC · «Это об одном цифры? 1623 + 309 не равно 1373» · The review remarks were recounted, the verdicts are broken down in full, and the reading of "refuted" was corrected.

2026-10-04 · article draft comment, §3.1, проблема 5, 06:51 UTC · «Тут я не в лучшем свете, не не замечая, а с вероятно что-то пропустить важное» · The sentence was rewritten as a property of the interface, and later as a hypothesis.

2026-10-04 · article draft comment, строка автора, 10:14 UTC · «тавтология» · The author line was rewritten.

2026-10-04 · article draft comment, аннотация, 10:15 UTC · «Меньше информации, просто обезличенный срез с классическим разделением» · The abstract was shortened.

2026-10-04 · article draft comment, аннотация, 10:17 UTC · «Может правильнее: В этом материале» · Accepted.

2026-10-04 · article draft comment, §2, 10:20 UTC · «Как-то странно звучит по русски» · The sentence was rewritten.

2026-10-04 · article draft comment, §3.2, 10:27 UTC · «Вот тут нужно понимать, что агент это и бот который авторизован как бот, но и агент типа claude или codex который от лица пользователя работает; да его сложнее идентифицировать - ны мы должны с оговоркой, это приемлема. Это такие же агента как те что я использую в keryx» · §3.2 now describes the two kinds of agents.

2026-10-04 · article draft comment, вклад авторов, 10:37 UTC · «тавтология?» · The contribution block was rewritten.

2026-10-04 · article draft comment, §7, 12:34 UTC · «Ну так прям явно не надо, зачем ссылки на коммиты?» · Commit hashes were removed from the article text.

2026-10-04 · article draft comment, строка автора, 12:35 UTC · «ведет разработку» · Accepted.

2026-10-04 · article draft comment, строка автора, 12:36 UTC · «все еще тавтология, перефразируй» · The author line became: the research and the text are the joint work of a human and agents.

2026-10-04 · article draft comment, аннотация (EN), 12:53 UTC · «Убери из текста такие тире - это явный признак генерации» · Parenthetical dashes were removed from the English text entirely and from the Russian text except where grammatically required.

2026-10-03 · operator session decision · «Ознакомься с ревью, проанализируй его, давай обсудим в чате как и что исправлять и там где будет блок описания кто работал над статьей, добавь рецензент GPT-6 Astra» · Work on the Astra review began; the review is mentioned in the contribution block.

2026-10-03 · operator session decision · «Не надо использовать весь опыт керикс так откровенно… не шокировать цифрами. Можно использовать как изменился подход и что теперь стало проверяемым.» · Tone of §3.1: the change of approach, not self-criticism by figures.

2026-10-04 · operator session decision · «Продолжение, давай без карты» · §3.2 was written without a role map; the only distinction is human versus agent.

2026-10-04 · operator session decision · «тогда меня план, делай упор на астру, кстати, отметь о качестве рецензий агентов в болке соавторства в конце статьи, и переписывай и русскую и английскую версию» · Plan of edits after the Astra review; an assessment of review quality in the contribution block; draft 6.

2026-10-04 · operator session decision · «Тогда там где требует моих решений - задавай интерактивные вопросы с вариантами ответов» · Protocol thresholds chosen by the operator: P1 ≥ 30% (refutation), P2 < 10%, P3 a three-level rubric, P5 observation plus a verdict within 14 days.

2026-10-04 · operator session decision · «Так, у нас в артифакте нет ни одной иллюстрации, нужно сделать, выбери только стиль отличный от того что генерят тысячами картинок BB» · Four schematic figures in a drafting style; then an overall figure 1 was added.

2026-10-04 · operator session decision · «Публиковаться будет прежде всего английская версия, русскую я проходил многократно» · Publication order: the English version first.

The rows after the first twelve come from the operator's export of draft comments of 2026-10-04; the original thread export is held by the operator.
