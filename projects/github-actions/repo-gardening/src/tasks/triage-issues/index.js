const { getInput, setFailed } = require( '@actions/core' );
const debug = require( '../../utils/debug' );
const getLabels = require( '../../utils/get-labels' );

/* global GitHub, WebhookPayloadIssue */

/**
 * Check for Priority labels on an issue.
 * It could be existing labels,
 * or it could be that it's being added as part of the event that triggers this action.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client.
 * @param {string} owner      - Repository owner.
 * @param {string} repo       - Repository name.
 * @param {string} number     - Issue number.
 * @param {string} action     - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @param {object} eventLabel - Label that was added to the issue.
 * @returns {Promise<Array>} Promise resolving to an array of Priority labels.
 */
async function hasPriorityLabels( octokit, owner, repo, number, action, eventLabel ) {
	const labels = await getLabels( octokit, owner, repo, number );
	if ( 'labeled' === action && eventLabel.name && eventLabel.name.match( /^\[Pri\].*$/ ) ) {
		labels.push( eventLabel.name );
	}

	return labels.filter( label => label.match( /^\[Pri\].*$/ ) );
}

/**
 * Check for a "[Status] Escalated" label showing that it was already escalated.
 * It could be an existing label,
 * or it could be that it's being added as part of the event that triggers this action.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client.
 * @param {string} owner      - Repository owner.
 * @param {string} repo       - Repository name.
 * @param {string} number     - Issue number.
 * @param {string} action     - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @param {object} eventLabel - Label that was added to the issue.
 * @returns {Promise<boolean>} Promise resolving to boolean.
 */
async function hasEscalatedLabel( octokit, owner, repo, number, action, eventLabel ) {
	// Check for an exisiting label first.
	const labels = await getLabels( octokit, owner, repo, number );
	if (
		labels.includes( '[Status] Escalated' ) ||
		labels.includes( '[Status] Escalated to Kitkat' )
	) {
		return true;
	}

	// If the issue is being labeled, check if the label is "[Status] Escalated".
	// No need to check for "[Status] Escalated to Kitkat" here, it's a legacy label.
	if (
		'labeled' === action &&
		eventLabel.name &&
		eventLabel.name.match( /^\[Status\] Escalated.*$/ )
	) {
		return true;
	}
}

/**
 * Ensure the issue is a bug, by looking for a "[Type] Bug" label.
 * It could be an existing label,
 * or it could be that it's being added as part of the event that triggers this action.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client.
 * @param {string} owner      - Repository owner.
 * @param {string} repo       - Repository name.
 * @param {string} number     - Issue number.
 * @param {string} action     - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @param {object} eventLabel - Label that was added to the issue.
 * @returns {Promise<boolean>} Promise resolving to boolean.
 */
async function isBug( octokit, owner, repo, number, action, eventLabel ) {
	// If the issue has a "[Type] Bug" label, it's a bug.
	const labels = await getLabels( octokit, owner, repo, number );
	if ( labels.includes( '[Type] Bug' ) ) {
		return true;
	}

	// Next, check if the current event was a [Type] Bug label being added.
	if ( 'labeled' === action && eventLabel.name && '[Type] Bug' === eventLabel.name ) {
		return true;
	}
}

/**
 * Find list of plugins impacted by issue, based off issue contents.
 *
 * @param {string} body - The issue content.
 * @returns {Array} Plugins concerned by issue.
 */
function findPlugins( body ) {
	const regex = /###\sImpacted\splugin\n\n([a-zA-Z ,]*)\n\n/gm;

	const match = regex.exec( body );
	if ( match ) {
		const [ , plugins ] = match;
		return plugins.split( ', ' ).filter( v => v.trim() !== '' );
	}

	debug( `triage-issues: No plugin indicators found.` );
	return [];
}

/**
 * Find platform info, based off issue contents.
 *
 * @param {string} body - The issue content.
 * @returns {Array} Platforms impacted by issue.
 */
function findPlatforms( body ) {
	const regex = /###\sPlatform\s\(Simple\sand\/or Atomic\)\n\n([a-zA-Z ,-]*)\n\n/gm;

	const match = regex.exec( body );
	if ( match ) {
		const [ , platforms ] = match;
		return platforms
			.split( ', ' )
			.filter( platform => platform !== 'Self-hosted' && platform.trim() !== '' );
	}

	debug( `triage-issues: no platform indicators found.` );
	return [];
}

/**
 * Figure out the priority of the issue, based off issue contents.
 * Logic follows this priority matrix: pciE2j-oG-p2
 *
 * @param {string} body - The issue content.
 * @returns {string} Priority of issue.
 */
function findPriority( body ) {
	// Look for priority indicators in body.
	const priorityRegex =
		/###\sImpact\n\n(?<impact>.*)\n\n###\sAvailable\sworkarounds\?\n\n(?<blocking>.*)\n/gm;
	let match;
	while ( ( match = priorityRegex.exec( body ) ) ) {
		const [ , impact = '', blocking = '' ] = match;

		debug(
			`triage-issues: Reported priority indicators for issue: "${ impact }" / "${ blocking }"`
		);

		if ( blocking === 'No and the platform is unusable' ) {
			return impact === 'One' ? 'High' : 'BLOCKER';
		} else if ( blocking === 'No but the platform is still usable' ) {
			return 'High';
		} else if ( blocking === 'Yes, difficult to implement' ) {
			return impact === 'All' ? 'High' : 'Normal';
		} else if ( blocking !== '' && blocking !== '_No response_' ) {
			return impact === 'All' || impact === 'Most (> 50%)' ? 'Normal' : 'Low';
		}
		return 'TBD';
	}

	debug( `triage-issues: No priority indicators found.` );
	return 'TBD';
}

/**
 * Automatically add labels to issues, and send Slack notifications.
 *
 * This task can send 2 different types of Slack notifications:
 * - If an issue is determined as High or Blocker priority,
 * - If no priority is determined.
 *
 * @param {WebhookPayloadIssue} payload - Issue event payload.
 * @param {GitHub}              octokit - Initialized Octokit REST client.
 */
async function triageIssues( payload, octokit ) {
	const { action, issue, label = {}, repository } = payload;
	const { number, body, state } = issue;
	const { owner, name, full_name } = repository;
	const ownerLogin = owner.login;

	const projectToken = getInput( 'project_automation_token' );
	if ( ! projectToken ) {
		setFailed(
			`add-issue-to-board: Input project_automation_token is required but missing. Aborting.`
		);
		return;
	}

	// ID of the board used to triage block-related issues.
	const projectId = 1;

	// Find Priority.
	const priorityLabels = await hasPriorityLabels(
		octokit,
		ownerLogin,
		name,
		number,
		action,
		label
	);
	if ( priorityLabels.length > 0 ) {
		debug(
			`triage-issues: Issue #${ number } has the following priority labels: ${ priorityLabels.join(
				', '
			) }`
		);
	} else {
		debug( `triage-issues: Issue #${ number } has no existing priority labels.` );
	}

	debug( `triage-issues: Finding priority for issue #${ number } based off the issue contents.` );
	const priority = findPriority( body );
	debug( `triage-issues: Priority for issue #${ number } is ${ priority }` );

	const isBugIssue = await isBug( octokit, ownerLogin, name, number, action, label );

	// If this is a new issue, try to add labels.
	if ( action === 'opened' || action === 'reopened' ) {
		// Find impacted plugins, and add labels.
		const impactedPlugins = findPlugins( body );
		if ( impactedPlugins.length > 0 ) {
			debug( `triage-issues: Adding plugin labels to issue #${ number }` );

			const pluginLabels = impactedPlugins.map( plugin => `[Plugin] ${ plugin }` );

			await octokit.rest.issues.addLabels( {
				owner: ownerLogin,
				repo: name,
				issue_number: number,
				labels: pluginLabels,
			} );
		}

		// Find platform info, and add labels.
		const impactedPlatforms = findPlatforms( body );
		if ( impactedPlatforms.length > 0 ) {
			debug( `triage-issues: Adding platform labels to issue #${ number }` );

			const platformLabels = impactedPlatforms.map( platform => `[Platform] ${ platform }` );

			await octokit.rest.issues.addLabels( {
				owner: ownerLogin,
				repo: name,
				issue_number: number,
				labels: platformLabels,
			} );
		}

		// Add priority label to all bugs, if none already exists on the issue.
		if ( priorityLabels.length === 0 && isBugIssue ) {
			debug( `triage-issues: Adding [Pri] ${ priority } label to issue #${ number }` );

			await octokit.rest.issues.addLabels( {
				owner: ownerLogin,
				repo: name,
				issue_number: number,
				labels: [ `[Pri] ${ priority }` ],
			} );
		}
	}
}
module.exports = triageIssues;
