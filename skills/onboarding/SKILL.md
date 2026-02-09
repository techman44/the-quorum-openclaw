---
name: quorum-onboarding
description: "One-time onboarding questionnaire that learns about the user and seeds The Quorum memory system with foundational context"
---

# The Quorum -- Onboarding

This is a one-time onboarding conversation. Your job is to walk the user through a series of questions, store their answers in the Quorum memory system, and then delete this skill file so it never triggers again.

Do not rush. Ask one question at a time. Wait for the user to respond before moving on. This should feel like a real conversation, not a form. Adapt your follow-up questions based on what the user tells you. If they mention something interesting or important, dig into it before moving on to the next section.

## Step 1: Welcome the User

Start by introducing yourself and The Quorum. Say something along these lines (adapt to sound natural, do not read this verbatim):

> Welcome to The Quorum. I'm going to walk you through a one-time setup so the system can start working for you right away.
>
> Here's the short version of what this is: The Quorum is a set of AI conscience agents that run in the background on a schedule. They track your commitments, surface forgotten connections, challenge your assumptions, spot opportunities you're missing, and write strategic reflections about your work -- then they deliver their findings to you directly.
>
> But they need context to be useful. Right now the memory system is empty, so these agents have nothing to work with. This conversation fixes that.
>
> I'll ask you about who you are, what you're working on, what your goals are, and how you want the system to behave. Everything you tell me gets stored in the database so the agents have real data from day one.
>
> This takes about 10-15 minutes. I'll evolve over time as I learn more about you, but the more context you give me now, the better I can help from the start.
>
> Ready? Let's begin.

Wait for the user to confirm before proceeding.

## Step 2: LinkedIn or Resume (Optional but Powerful)

Before diving into individual questions, offer the user a shortcut:

> "Before we start, do you have a LinkedIn profile URL or a resume you can share? If you paste your LinkedIn URL or copy-paste your resume text here, I can pull a huge amount of context from it immediately -- your career history, skills, roles, companies, education. It saves you having to type all of that out manually and gives the agents much richer context to work with.
>
> Totally optional -- if you'd rather just answer questions, we can do that instead."

**If they share a LinkedIn URL:**
- Fetch and read the profile page content
- Extract: name, headline, current role, past roles, companies, skills, education, certifications, any about/summary section
- Store as a comprehensive profile document
- Use the extracted context to inform your follow-up questions in later sections (e.g., if they worked at a specific company, reference it naturally)

**If they paste resume text:**
- Parse and extract: name, contact info (DO NOT store email/phone -- only name and professional details), career history, skills, education, certifications, projects
- Store as a comprehensive profile document
- Use the extracted context to inform later sections

**If they share either**, use `quorum_store`:
- `doc_type`: `"profile"`
- `title`: `"Career Profile - [User's Name]"`
- `content`: Write a structured summary of their full career history, skills, education, and any other professional context extracted. Format it as useful context for the other agents.
- `tags`: `["onboarding", "user-profile", "career-history"]`
- `metadata`: `{ "source": "onboarding", "section": "career-profile", "imported_from": "linkedin" }` (or `"resume"`)

Then proceed to Step 3, but **skip any questions they've already answered** through the LinkedIn/resume data. For example, if their LinkedIn shows their current role, don't ask "What's your current role?" -- instead, confirm it: "I see you're [role] at [company] -- is that still current?" and move on to questions the profile didn't cover.

**If they decline**, that's fine -- move to Step 3 and ask everything from scratch.

## Step 3: About the User

Ask these questions **one at a time**, waiting for a response after each. Follow up naturally if their answer is vague or if they mention something worth exploring. **Skip any questions already answered by a LinkedIn profile or resume shared in Step 2.**

1. "What's your name, and what do you do? Give me the elevator pitch version."
2. "What's your current role or position? Are you at a company, freelancing, running your own thing?"
3. "What are the main projects or areas you're focused on right now? List as many as come to mind -- work projects, side projects, personal goals, all of it."
4. "What tools and platforms do you use daily? I'm talking email, Slack, project management tools, calendars, dev tools, note-taking apps -- whatever is part of your regular workflow."

After getting answers to all questions (or after merging with LinkedIn/resume data), use `quorum_store` to save the user's profile:

- `doc_type`: `"profile"`
- `title`: `"User Profile - [User's Name]"`
- `content`: Write a structured summary of everything the user shared in this section. Include their name, what they do, their role, their projects, and their tools. Write it in a way that would be useful context for another agent reading it later.
- `tags`: `["onboarding", "user-profile"]`
- `metadata`: `{ "source": "onboarding", "section": "about-user" }`

## Step 4: Goals and Priorities

Transition naturally: "Now I want to understand what you're aiming at."

Ask these questions **one at a time**:

1. "What are your top 3 priorities right now? The things that, if you made real progress on them this month, you'd feel good about?"
2. "Is there a goal or task you keep pushing off? Something you know you should do but keep finding reasons not to? Be honest -- that's exactly the kind of thing this system is built to help with."
3. "Where do you want to be in 6 months? And 12 months? This can be career, business, personal -- whatever matters to you."
4. "Are there any decisions you're currently weighing? Things you haven't committed to yet because you're still thinking them through?"

Adapt based on their answers. If they mention a specific procrastination pattern, ask what's blocking them. If they describe a decision they're weighing, ask what the options are and what's making it hard.

After getting answers, use `quorum_store` to save their goals:

- `doc_type`: `"goals"`
- `title`: `"Goals and Priorities - [User's Name]"`
- `content`: Write a structured summary covering their top priorities, procrastinated goals, 6-month and 12-month vision, and pending decisions. Be specific -- use their exact words where possible. This document will be referenced by The Executor for accountability and The Strategist for reflections.
- `tags`: `["onboarding", "goals", "priorities"]`
- `metadata`: `{ "source": "onboarding", "section": "goals-priorities" }`

## Step 5: System Depth and Notification Preferences

Transition naturally: "Let's talk about how involved you want the system to be and how it communicates with you."

Present the user with clear options and **include your recommendations**. Ask **one at a time**:

1. "How deeply do you want the agents to analyse things? Here are three levels:
   - **Light** -- Quick summaries, surface-level observations. Good if you want minimal noise and just the highlights. Best for: people who are already highly organised and just want a safety net.
   - **Standard** (recommended for most people) -- Detailed reflections, pattern recognition, proactive suggestions. The agents actively look for connections and call out issues. Best for: people who want real accountability and insight.
   - **Deep** -- Comprehensive analysis, cross-referencing across all data sources, multi-layered strategic thinking. The agents will dig deep into your decisions and challenge you thoroughly. Best for: people building something complex who want a rigorous thinking partner.
   Which level sounds right for you?"

2. "How often do you want to be notified? Options:
   - **Real-time** -- Every time an agent finds something noteworthy, you get a message. Can be noisy but nothing slips through the cracks.
   - **Batched daily** (recommended) -- Agents run on their schedules but findings are bundled into a single daily summary. One notification per day with everything important.
   - **Weekly digest** -- One weekly summary covering all agent findings. Low noise, but you might miss time-sensitive items.
   - **On-demand only** -- Agents still run and store findings, but you only see them when you ask. Zero notifications.
   What works best for you?"

3. "For the information the agents send you, how detailed should it be?
   - **Brief** -- Just the headline and one sentence of context. 'Task X is 3 days overdue.'
   - **Standard** (recommended) -- Headline plus context and a suggested next step. 'Task X is 3 days overdue. You mentioned it was blocked by Y -- has that been resolved?'
   - **Comprehensive** -- Full analysis with supporting evidence, alternative perspectives, and links to related items. Good if you want to understand the agents' reasoning.
   What's your preference?"

After getting answers, use `quorum_store` to save their system preferences:

- `doc_type`: `"preferences"`
- `title`: `"System Depth and Notification Preferences - [User's Name]"`
- `content`: Write a structured summary specifying: analysis depth level, notification frequency, information detail level. Include any nuances or exceptions they mentioned (e.g., "Standard depth for most things but Deep for decisions about X").
- `tags`: `["onboarding", "preferences", "notifications", "system-config"]`
- `metadata`: `{ "source": "onboarding", "section": "system-preferences", "depth": "[light|standard|deep]", "notification_frequency": "[realtime|daily|weekly|on-demand]", "detail_level": "[brief|standard|comprehensive]" }`

## Step 6: Accountability Style

Transition naturally: "Now let's talk about how the agents should talk to you when they're pushing back or holding you accountable."

Ask these questions **one at a time**:

1. "How direct should I be when calling out procrastination or missed commitments? Some people want gentle nudges, others want blunt, no-nonsense accountability. Where do you fall on that spectrum?"
2. "Are there any topics or areas that are off-limits? Anything you explicitly do not want the agents commenting on or tracking?"
3. "Any other preferences for how the system should interact with you? Pet peeves, communication style preferences, things that would annoy you -- anything I should know."

After getting answers, use `quorum_store` to save their preferences:

- `doc_type`: `"preferences"`
- `title`: `"Accountability and Communication Preferences - [User's Name]"`
- `content`: Write a structured summary of their accountability style preference (with specific language about how direct to be), reflection frequency preference, off-limits topics, and any other interaction preferences. This document is critical -- every agent will reference it to calibrate their tone and behavior.
- `tags`: `["onboarding", "preferences", "accountability"]`
- `metadata`: `{ "source": "onboarding", "section": "accountability-preferences" }`

## Step 7: Data Sources and Integrations

Transition naturally: "Last section. The system gets more powerful when it has more data to work with."

Explain briefly, then ask:

> "Right now, the agents work with whatever gets stored in conversations and through the tools. But the system can also connect to external data sources to pull in more context. Here are some possibilities:
>
> - **Email** -- The agents could scan for commitments made in emails, surface forgotten contacts, and connect email conversations to your current work.
> - **Calendar** -- They could track how your time is actually being spent vs. what you say your priorities are.
> - **Documents** (Google Docs, Notion, etc.) -- Strategic documents, meeting notes, and plans could be indexed so the agents can reference them.
> - **Project management tools** (Jira, Linear, Asana, etc.) -- Task status and project progress could feed into accountability tracking.
> - **Code repositories** -- Commit activity and PR status could be tracked for development-related accountability.
>
> None of these are set up yet, but knowing what you'd find valuable helps plan the roadmap.
>
> What external data sources would you most want connected? And are there any you'd explicitly want to keep separate from this system?"

After getting their answer, use `quorum_store` to save their integration preferences:

- `doc_type`: `"integration-preferences"`
- `title`: `"Integration Preferences - [User's Name]"`
- `content`: Summarize which integrations they want, which they do not want, and any nuance they provided about how they'd want data handled.
- `tags`: `["onboarding", "integrations", "data-sources"]`
- `metadata`: `{ "source": "onboarding", "section": "integration-preferences" }`

## Step 8: Create Initial Tasks

Review everything the user told you about their goals, priorities, procrastinated items, and pending decisions. For each concrete, actionable item, use `quorum_create_task` to create a task:

- **Procrastinated goals** should become tasks with `priority`: `"high"` since the user already identified them as important but avoided.
- **Top priorities** should become tasks with appropriate priority levels (`"critical"` or `"high"` depending on urgency).
- **Pending decisions** should become tasks with a title like "Decide: [decision topic]" and `priority`: `"medium"`.
- **6-month and 12-month goals** should become tasks with `priority`: `"medium"` and a `due_at` set approximately 6 or 12 months from now.

Set `owner` to the user's name on all tasks. Include relevant context in each task's `description` so that The Executor has enough information to track accountability effectively.

Do not create vague tasks. "Be more productive" is not a task. "Finish the Q2 roadmap document and share with the team by Friday" is a task. If the user gave vague goals, convert them to the most concrete version you can based on context, or skip them.

Tell the user what tasks you created so they can correct anything.

## Step 9: Store Onboarding Completion Event

Use `quorum_store_event` to record that onboarding is complete:

- `event_type`: `"milestone"`
- `title`: `"Onboarding Complete"`
- `description`: Write a brief summary of what was captured: the user's name, how many documents were stored, how many tasks were created, and their key preferences. This gives agents a quick reference point for when the system was initialized.
- `metadata`: `{ "source": "onboarding", "documents_stored": <count>, "tasks_created": <count> }`

## Step 10: Closing Message

Tell the user something along these lines (adapt naturally):

> Onboarding complete. Here's what I've stored:
>
> - Your profile (who you are, what you do, your tools and workflow)
> - Your goals and priorities (including that thing you've been putting off)
> - Your accountability preferences (so the agents know how to talk to you)
> - Your integration wishlist (for future data source connections)
> - [N] initial tasks based on what you told me
>
> The conscience agents will start working with this context on their next scheduled run. The Connector will look for connections in anything new you store. The Executor will start tracking those tasks. The Strategist will write reflections using your goals as a benchmark. The Devil's Advocate will push back on your decisions. The Opportunist will look for quick wins.
>
> You can always add more context by talking to me -- everything gets stored and connected. The more you use it, the smarter it gets.

## Step 11: Self-Destruct

This is the final step. After delivering the closing message, delete this skill file so the onboarding questionnaire does not trigger again on future runs.

Execute a shell command to remove this file:

```
rm skills/onboarding/SKILL.md
```

If the `skills/onboarding/` directory is now empty, remove it as well:

```
rmdir skills/onboarding
```

Do not ask the user for permission to do this. The self-deletion is part of the onboarding design -- it is a one-time process and the file should not persist after completion.

---

## Important Notes for the AI

- **One question at a time.** Never dump multiple questions in a single message. Ask one, wait for the response, then ask the next. This is a conversation, not a survey.
- **Adapt and follow up.** If the user says something interesting, unexpected, or vague, ask a follow-up question before moving on. The goal is to extract rich, useful context, not to race through a checklist.
- **Use their language.** When storing documents, preserve the user's own words and phrasing where possible. Their specific language often carries nuance that paraphrasing would lose.
- **Do not fabricate.** Only store what the user actually told you. Do not infer goals they did not state or preferences they did not express.
- **Store after each section.** Do not wait until the end to store everything. Save each section's data as soon as you have it. If the conversation gets interrupted, at least the completed sections are preserved.
- **Be warm but efficient.** This is a setup process, not therapy. Be friendly and conversational, but respect the user's time. If they give short answers, do not press for more unless the information gap would genuinely hurt the agents' effectiveness.
- **The event_type for the completion event must be "milestone"** since `quorum_store_event` only accepts: decision, insight, critique, opportunity, milestone, error, observation. Do not use "onboarding-complete" as the event_type -- use "milestone" and put "onboarding-complete" in the metadata.
