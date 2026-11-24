# Work on a GitHub issue in Keryx Desktop

Open **Issues** and select the GitHub account that has access to the ticket. The account menu uses the accounts connected through GitHub CLI. To connect another account, sign in with `gh auth login` and reopen the account settings. The board initially shows open issues of the project's GitHub repository (source **Project repository**). Choose **Assigned to me**, **Created by me**, **Mentioned** or **Subscribed** to see a personal queue across repositories, or **GitHub Project** to open a Project. Desktop remembers the chosen source for this project and account.

The board has an **Open** column, plus **Closed** when the state filter includes closed issues. Columns follow the GitHub state only. A GitHub Project uses its own columns, described below.

## Find and read an issue

Search by title, `#number` or `owner/repo#number`. **Filters** can narrow the queue by repository, GitHub state, update date, author, label and assignee. Enter **Unassigned** to find unassigned tickets. **Board** and **List** share the filters. Use **Load more issues** to extend the search beyond the loaded pages. **Refresh** reads the current query again.

Select a title to read the description, followed by the comments. Use the arrow buttons to navigate between issues or **Open in GitHub** to view the original. On a wide window, drag the divider or focus it and use the arrow keys to resize the panel. Escape returns to the board or list.

## See the Keryx work on an issue

Each card, list row and issue panel has a Keryx work row with two slots:

- **Flow.** **Flow · stage** opens the Flow linked to the issue, for example **Flow · In progress** or **Flow · Needs an answer**. Without a Flow, the slot reads **Create Flow**.
- **Session.** **Session** or **N sessions** counts the sessions bound to the issue and opens its linked session. Without one, the slot reads **Open in session**, or **Open question** when the Flow waits for your answer.

The list and the issue panel also show the Keryx stage next to the GitHub state.

## Discuss an issue and prepare a Flow

1. Select **Open in session** on the issue. Keryx looks for a registered checkout of the issue repository. If several match, choose the one you want. If none match, use **Choose folder** to open the checkout. The selected account needs access to the repository and the project's GitHub binding.
2. Discuss the work in **Sessions**. **Create Flow** from the same issue uses the linked session, including its existing conversation. You may also select **Create Flow** directly. The checkout needs Task Manager and a compatible Keryx shell provider.
3. Review the coordinator's plan, dependent tasks and acceptance criteria. When the issue says **Needs an answer**, open the session to read and answer the question. Use the Flow slot to inspect the package, including an existing package created from the same GitHub issue URL in Shell. If several packages match, choose the intended directory.
4. When you accept the criteria, freeze and start that Flow from its checkout. For example, with the numeric ID shown in Flows:

```bash
keryx flow status <id>
keryx flow freeze <id>
keryx flow start <id>
keryx flow next <id>
```

The GitHub state and Keryx stage are shown independently. An open issue can have a finished Flow, and work can continue on a closed issue.

## Use a GitHub Project

Choose **GitHub Project**, enter the organization or user login and the Project number, then select **Open project**. The columns follow the Project's single-select **Status** field. **No status** holds items with no value. Other sources group the same issues by GitHub state.

Choose a value in the item's **Change Project Status** menu or drag the card to a column to update that item in the selected Project. Keryx reads the current value before writing and reads it back afterwards. If a teammate changed it first, the board shows the observed value. Choose a new destination only if you still want to move it. In a read-only Project, you can open issues and sessions. If the Status field is unavailable, use the list or select a different Project.

## Recover a session, an interrupted request or a missing board

- **Project repository unavailable.** This source needs a GitHub.com remote in the project that names a repository, and Issues turned on for that repository. A keryx older than Desktop does not know this source either. In those cases Issues shows the reason and **Show issues assigned to me**, which switches this project to that source and remembers it. Any other error shows **Retry**. For an older keryx, update it or select **Bundled keryx** in **Settings → Desktop**.
- **No access or wrong account.** Select the GitHub account with repository access and verify the checkout's GitHub binding. GitHub can report a missing private issue when access is denied. For a restricted Project, switch Source back to a personal queue.
- **Offline or rate limited.** A failed refresh can leave the most recent authorized snapshot visible. Read the error and retry after connectivity returns or the stated GitHub limit resets. An access denial clears private board data.
- **Interrupted preparation.** Reopen the issue using the same account and checkout, then open its linked session and Flow. Read the latest turn, pending question and package before resuming preparation. If the session was busy when Keryx created the package, wait for the current turn to finish and choose **Resume preparation** on the issue. Keryx reuses that package and session. If another Shell or Desktop window owns the session, finish or disconnect that writer first.
- **Incompatible CLI.** In **Settings → Desktop**, select **Bundled keryx** or a CLI with `keryx issues --help`. Reconnect the session and reopen Issues. A local folder with the right remote is needed for session and Flow actions.

## Return to the source ticket

Choose **Open source issue** beside a linked session's title or in the Flow detail header. Desktop opens the ticket even if it falls outside the current filters. In an issue session, select the GitHub account that created that session. A shared Flow can resolve its source for any selected account with access to the ticket.

From the project checkout, Shell can resolve either link against GitHub with the selected login. Use an exact session UUID or Flow package directory name.

```sh
keryx issues origin --login LOGIN --request '{"sessionId":"SESSION-UUID"}' --json
keryx issues origin --login LOGIN --request '{"flowDir":"FLOW-PACKAGE-DIRECTORY"}' --json
```
