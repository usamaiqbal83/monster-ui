define(function(require) {
	var $ = require('jquery'),
		_ = require('underscore'),
		monster = require('monster'),
		toastr = require('toastr');

	var app = {

		name: 'auth',

		css: [ 'app' ],

		i18n: {
			'en-US': { customCss: false },
			'fr-FR': { customCss: false },
			'ru-RU': { customCss: false }
		},

		appFlags: {
			kazooConnectionName: 'kazooAPI',
			mainContainer: undefined,
			isAuthentified: false,
			connections: {}
		},

		requests: {
			'auth.upgradeTrial': {
				apiRoot: monster.config.api.screwdriver,
				url: 'upgrade',
				verb: 'POST'
			}
		},

		subscribe: {
			'auth.logout': '_logout',
			'auth.clickLogout': '_clickLogout',
			'auth.initApp': '_initApp',
			'auth.afterAuthenticate': '_afterSuccessfulAuth',
			'auth.showTrialInfo': 'showTrialInfo'
		},

		load: function(callback) {
			var self = this;

			callback && callback(self);
		},

		render: function(mainContainer) {
			var self = this;

			self.appFlags.mainContainer = mainContainer;

			self.triggerLoginMechanism();
		},

		// Order of importance: Cookie > GET Parameters > External Auth > Default Case
		triggerLoginMechanism: function() {
			var self = this,
				urlParams = monster.util.getUrlVars(),
				successfulAuth = function(authData) {
					self._afterSuccessfulAuth(authData);
				},
				errorAuth = function() {
					self.renderLoginPage();
				};

			// First check if there is a custom authentication mechanism
			if (monster.config.whitelabel.hasOwnProperty('authentication')) {
				self.customAuth = monster.config.whitelabel.authentication;

				var options = {
					sourceUrl: self.customAuth.source_url,
					apiUrl: self.customAuth.api_url
				};

				monster.apps.load(self.customAuth.name, function(app) {
					app.render(self.appFlags.mainContainer);
				}, options);
			} else if (monster.config.whitelabel.hasOwnProperty('sso')) {
				var sso = monster.config.whitelabel.sso,
					token = $.cookie(sso.cookie.name);

				monster.config.whitelabel.logoutTimer = 0;

				if (token && token.length) {
					self.authenticateAuthToken(token, successfulAuth, function(data) {
						if (data.httpErrorStatus === 403) {
							window.location = sso.no_account;
						} else {
							$.cookie(sso.cookie.name, null);
							window.location = sso.login;
						}
					});
				} else {
					window.location = sso.login;
				}
			} else if (urlParams.hasOwnProperty('recovery')) {
				self.checkRecoveryId(urlParams.recovery, successfulAuth);
			} else if ($.cookie('monster-auth')) {
				// otherwise, we handle it ourself, and we check if the authentication cookie exists, try to log in with its information
				var cookieData = $.parseJSON($.cookie('monster-auth'));

				self.authenticateAuthToken(cookieData.authToken, function(data) {
					data.loginData = {
						credentials: cookieData.credentials,
						account_name: cookieData.accountName
					};

					successfulAuth && successfulAuth(data);
				}, errorAuth);
			} else if (urlParams.hasOwnProperty('u') && urlParams.hasOwnProperty('t')) {
				// Otherwise, we check if some GET parameters are defined, and if they're formatted properly
				//APIkey generated tokens require UserId parameter to login.
				self.authenticateAuthToken(urlParams.t, function(authData) {
					authData.data.owner_id = urlParams.u;
					successfulAuth(authData);
				}, errorAuth);
			} else if (urlParams.hasOwnProperty('t')) {
				// Username/password generated tokens do not require anything else to log in.
				self.authenticateAuthToken(urlParams.t, successfulAuth, errorAuth);
			} else if (urlParams.hasOwnProperty('state') && urlParams.hasOwnProperty('code')) {
				// If it has state and code key, then it's most likely a SSO Redirect
				self.getNewOAuthTokenFromURLParams(urlParams, function(authData) {
					// Once we set our token we refresh the page to get rid of new URL params from auth callback
					self.buildCookiesFromSSOResponse(authData);

					window.location.href = window.location.protocol + '//' + window.location.host;
				}, errorAuth);
			} else {
				// Default case, we didn't find any way to log in automatically, we render the login page
				self.renderLoginPage();
			}
		},

		getNewOAuthTokenFromURLParams: function(params, success, error) {
			var self = this,
				tmp = JSON.parse(atob(decodeURIComponent(params.state))),
				url = window.location.protocol + '//' + window.location.host,
				data = $.extend(true, {redirect_uri: url}, tmp, params);

			self.authenticateAuthCallback(data, function(authData) {
				success && success(authData);
			}, error);
		},

		buildCookiesFromSSOResponse: function(authData) {
			var decoded = monster.util.jwt_decode(authData.auth_token);

			$.cookie('monster-sso-auth', JSON.stringify(decoded));

			if (decoded.hasOwnProperty('account_id')) {
				$.cookie('monster-auth', JSON.stringify({ authToken: authData.auth_token }));
			} else {
				$.cookie('monster-auth', null);
			}

			return decoded;
		},

		authenticateAuthToken: function(authToken, callback, errorCallback) {
			var self = this;

			self.getAuth(authToken,
				function(authData) {
					callback && callback(authData);
				},
				function(error) {
					errorCallback && errorCallback(error);
				}
			);
		},

		authenticateAuthCallback: function(data, callback, errorCallback) {
			var self = this;

			self.putAuthCallback(data,
				function(authData) {
					callback && callback(authData);
				},
				function(error) {
					errorCallback && errorCallback(error);
				}
			);
		},

		// We update the token with the value stored in the auth cookie.
		// If the value is null, we force a logout
		setKazooAPIToken: function(token) {
			var self = this;

			if (token) {
				self.appFlags.connections[self.appFlags.kazooConnectionName].authToken = token;
			} else {
				self._logout();
			}
		},

		updateTokenFromWhitelabelCookie: function() {
			var self = this,
				tokenCookie = monster.config.whitelabel.sso.hasOwnProperty('cookie') && monster.config.whitelabel.sso.cookie.name ? $.cookie(monster.config.whitelabel.sso.cookie.name) : undefined;

			self.setKazooAPIToken(tokenCookie);
		},

		updateTokenFromMonsterCookie: function() {
			var self = this,
				cookieMonster = $.cookie('monster-auth'),
				tokenCookie = cookieMonster ? $.parseJSON(cookieMonster).authToken : undefined;

			self.setKazooAPIToken(tokenCookie);
		},

		getAuthTokenByConnection: function(pConnectionName) {
			var self = this,
				connectionName = pConnectionName || self.appFlags.kazooConnectionName,
				hasConnection = self.appFlags.connections.hasOwnProperty(connectionName),
				authToken;

			if (hasConnection) {
				if (connectionName === self.appFlags.kazooConnectionName) {
					if (monster.config.whitelabel.hasOwnProperty('sso')) {
						self.updateTokenFromWhitelabelCookie();
					} else {
						self.updateTokenFromMonsterCookie();
					}
				}

				authToken = self.appFlags.connections[connectionName].authToken;
			}

			return authToken;
		},

		_afterSuccessfulAuth: function(data, pUpdateLayout) {
			var self = this,
				updateLayout = pUpdateLayout === false ? false : true;

			self.accountId = data.data.account_id;

			// We removed the auth token as we no longer want it to be static, we need to use a function to get a dynamic value (if it's stored in a cookie, we need to check every time)
			// Down the road we should probably remove userId, accountId etc from the self here.
			self.userId = data.data.owner_id;
			self.isReseller = data.data.is_reseller;
			self.resellerId = data.data.reseller_id;

			self.appFlags.isAuthentified = true;

			self.appFlags.connections[self.appFlags.kazooConnectionName] = {
				accountId: data.data.account_id,
				authToken: data.auth_token,
				userId: data.data.owner_id
			};

			if ('apps' in data.data) {
				self.installedApps = data.data.apps;
			} else {
				self.installedApps = [];
				toastr.error(self.i18n.active().toastrMessages.appListError);
			}

			// We store the language so we can load the right language before having to query anything in our back-end. (no need to query account, user etc)
			var cookieAuth = {
				language: data.data.language,
				authToken: data.auth_token,
				accountId: data.data.account_id
			};

			if (data.hasOwnProperty('loginData')) {
				cookieAuth.credentials = data.loginData.credentials;
				cookieAuth.accountName = data.loginData.account_name;
			}

			$.cookie('monster-auth', JSON.stringify(cookieAuth));

			// In the case of the retry login, we don't want to re-update the UI, we just want to re-update the flags set above, that's why we added this parameter.
			if (updateLayout) {
				$('.core-footer').append(self.appFlags.mainContainer.find('.powered-by-block .powered-by'));
				self.appFlags.mainContainer.empty();

				self.afterLoggedIn(data.data);
			}
		},

		//Events handler
		_clickLogout: function() {
			var self = this;

			monster.ui.confirm(self.i18n.active().confirmLogout, function() {
				self._logout();
			});
		},

		//Methods
		afterLoggedIn: function(dataLogin) {
			var self = this;

			$('#main_topbar_apploader').show();

			self.loadAccount(dataLogin);
		},

		loadAccount: function(dataLogin) {
			var self = this;

			monster.parallel({
				appsStore: function(callback) {
					self.getAppsStore(function(data) {
						callback(null, data);
					});
				},
				account: function(callback) {
					self.getAccount(self.accountId, function(data) {
						callback(null, data.data);
					},
					function(data) {
						callback('error account', data);
					});
				},
				user: function(callback) {
					self.getUser(function(data) {
						callback(null, data.data);
					},
					function(data) {
						callback('error user', data);
					});
				}
			},
			function(err, results) {
				var defaultApp;

				if (err) {
					monster.util.logoutAndReload();
				} else {
					if (results.user.hasOwnProperty('require_password_update') && results.user.require_password_update) {
						self.newPassword(results.user);
					}

					monster.util.autoLogout();
					$('#main_topbar_signout').show();

					results.user.account_name = results.account.name;
					results.user.apps = results.user.apps || {};
					results.account.apps = results.account.apps || {};

					var afterLanguageLoaded = function() {
						var fullAppList = _.indexBy(self.installedApps, 'id'),
							defaultAppId = _.find(results.user.appList || [], function(appId) {
								return fullAppList.hasOwnProperty(appId);
							});

						if (defaultAppId) {
							defaultApp = fullAppList[defaultAppId].name;
						} else if (self.installedApps.length > 0) {
							defaultApp = self.installedApps[0].name;
						}

						monster.appsStore = _.indexBy(results.appsStore, 'name');

						self.currentUser = results.user;
						// This account will remain unchanged, it should be used by non-masqueradable apps
						self.originalAccount = results.account;
						// This account will be overriden when masquerading, it should be used by masqueradable apps
						self.currentAccount = $.extend(true, {}, self.originalAccount);

						self.defaultApp = defaultApp;

						self.showAnnouncement(self.originalAccount.announcement);

						if ('ui_flags' in results.user && results.user.ui_flags.colorblind) {
							$('body').addClass('colorblind');
						}

						if (monster.util.isAdmin()) {
							$('#main_topbar_account_toggle_link').addClass('visible');
						}

						monster.pub('core.initializeShortcuts', dataLogin.apps);

						monster.pub('core.loadApps', {
							defaultApp: defaultApp
						});
					};

					// If the user or the account we're logged into has a language settings, and if it's different than
					var loadCustomLanguage = function(language, callback) {
						if (language !== monster.config.whitelabel.language && language !== monster.apps.defaultLanguage) {
							monster.apps.loadLocale(monster.apps.core, language, function() {
								monster.apps.loadLocale(self, language, function() {
									monster.config.whitelabel.language = language;

									callback && callback();
								});
							});
						} else {
							monster.config.whitelabel.language = language;
							callback && callback();
						}
					};

					/* If user has a preferred language, then set the i18n flag with this value, and download the customized i18n
					if not, check if the account has a default preferred language */
					if ('language' in results.user) {
						loadCustomLanguage(results.user.language, afterLanguageLoaded);
					} else if ('language' in results.account) {
						loadCustomLanguage(results.account.language, afterLanguageLoaded);
					} else {
						afterLanguageLoaded && afterLanguageLoaded();
					}
				}
			});
		},

		showAnnouncement: function() {
			var self = this,
				announcement = self.originalAccount.announcement || monster.config.whitelabel.announcement;

			if (announcement) {
				monster.ui.alert('info', announcement, null, { title: self.i18n.active().announcementTitle });
			}
		},

		showTrialInfo: function(timeLeft) {
			var self = this,
				daysLeft = timeLeft > 0 ? Math.ceil(timeLeft / (60 * 60 * 24)) : -1,
				hasAlreadyLogIn = self.uiFlags.user.get('hasLoggedIn') ? true : false,
				template = $(monster.template(self, 'trial-message', { daysLeft: daysLeft }));

			template.find('.links').on('click', function() {
				self.showTrialPopup(daysLeft);
			});

			$('#main_topbar_nav').prepend(template);

			hasAlreadyLogIn ? self.showTrialPopup(daysLeft) : self.showFirstTrialGreetings();
		},

		showFirstTrialGreetings: function() {
			var self = this,
				updateUser = function(callback) {
					var userToSave = self.uiFlags.user.set('hasLoggedIn', true);

					self.updateUser(userToSave, function(user) {
						callback && callback(user);
					});

					monster.pub('auth.continueTrial');
				};

			var popup = $(monster.template(self, 'trial-greetingsDialog'));

			popup.find('#acknowledge').on('click', function() {
				dialog.dialog('close').remove();

				updateUser && updateUser();
			});

			var dialog = monster.ui.dialog(popup, {
				title: self.i18n.active().trialGreetingsDialog.title
			});

			// Update the flag of the walkthrough is they don't care about it
			dialog.siblings().find('.ui-dialog-titlebar-close').on('click', function() {
				updateUser && updateUser();
			});
		},

		updateUser: function(data, callback) {
			var self = this;

			self.callApi({
				resource: 'user.update',
				data: {
					accountId: self.accountId,
					data: data
				},
				success: function(data) {
					callback && callback(data.data);
				}
			});
		},

		showTrialPopup: function(daysLeft) {
			var self = this,
				alreadyUpgraded = self.uiFlags.account.get('trial_upgraded');

			if (alreadyUpgraded) {
				monster.ui.alert('info', self.i18n.active().trialPopup.alreadyUpgraded);
			} else {
				if (daysLeft >= 0) {
					monster.ui.confirm(
						'', // Marketing content goes here
						function() {
							self.handleUpgradeClick();
						},
						function() {
							monster.pub('auth.continueTrial');
						},
						{
							title: monster.template(self, '!' + self.i18n.active().trialPopup.mainMessage, { variable: daysLeft }),
							cancelButtonText: self.i18n.active().trialPopup.closeButton,
							confirmButtonText: self.i18n.active().trialPopup.upgradeButton,
							confirmButtonClass: 'monster-button-primary',
							type: 'warning'
						}
					);
				} else {
					monster.ui.alert(
						'error',
						'', // Marketing content goes here
						function() {
							self.handleUpgradeClick();
						},
						{
							closeOnEscape: false,
							title: self.i18n.active().trialPopup.trialExpired,
							closeButtonText: self.i18n.active().trialPopup.upgradeButton,
							closeButtonClass: 'monster-button-primary'
						}
					);
				}
			}
		},

		handleUpgradeClick: function() {
			var self = this;

			monster.pub('myaccount.hasCreditCards', function(response) {
				if (response) {
					self.upgradeAccount(self.accountId, function() {
						monster.ui.alert('info', self.i18n.active().trial.successUpgrade.content, null, {
							title: self.i18n.active().trial.successUpgrade.title
						});
					});
				} else {
					monster.pub('myaccount.showCreditCardTab');

					toastr.error(self.i18n.active().trial.noCreditCard);
				}
			});
		},

		upgradeAccount: function(accountId, callback) {
			var self = this;

			self.sendUpgradeTrialRequest(accountId, function() {
				self.setUpgradeFlagAccount(accountId, function(data) {
					callback && callback(data);
				});
			});
		},

		sendUpgradeTrialRequest: function(accountId, callback) {
			var self = this;

			monster.request({
				resource: 'auth.upgradeTrial',
				data: {
					envelopeKeys: {
						id: accountId
					}
				},
				success: function(data, status) {
					callback && callback(data);
				}
			});
		},

		setUpgradeFlagAccount: function(accountId, callback) {
			var self = this;

			self.getAccount(accountId, function(data) {
				var accountData = self.uiFlags.account.set('trial_upgraded', true, data.data);

				self.callApi({
					resource: 'account.update',
					data: {
						accountId: self.accountId,
						data: accountData
					},
					success: function(data) {
						callback && callback(data.data);
					}
				});
			});
		},

		formatSSOProviders: function(providers) {
			var self = this;

			_.each(providers, function(provider) {
				provider.params.scope = provider.params.scopes.join(' ');
				provider.params.redirect_uri = window.location.protocol + '//' + window.location.host;
				var stateData = {
					client_id: provider.params.client_id,
					provider: provider.name
				};
				provider.params.state = btoa(JSON.stringify(stateData));
				delete provider.params.scopes;

				provider.link_url = provider.url + '?' + $.param(provider.params);
			});

			return providers;
		},

		renderSSOProviderTemplate: function(container) {
			monster.config.whitelabel.sso_providers = [{"url":"https://accounts.google.com/o/oauth2/auth","authenticate_photoUrl":false,"name":"google","friendly_name":"Google","params":{"popup": true, "client_id":"24412119-8h2t58nn70ehbshl78iqjlcvt8gd8786.apps.googleusercontent.com","response_type":"code","include_granted_scopes":true,"scope":"openid profile email","redirect_uri":"http://localhost:3000","state":"eyJjbGllbnRfaWQiOiIyNDQxMjExOS04aDJ0NThubjcwZWhic2hsNzhpcWpsY3Z0OGdkODc4Ni5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbSIsInByb3ZpZGVyIjoiZ29vZ2xlIn0="},"link_url":"https://accounts.google.com/o/oauth2/auth?client_id=24412119-8h2t58nn70ehbshl78iqjlcvt8gd8786.apps.googleusercontent.com&response_type=code&include_granted_scopes=true&scope=openid+profile+email&redirect_uri=http%3A%2F%2Flocalhost%3A3000&state=eyJjbGllbnRfaWQiOiIyNDQxMjExOS04aDJ0NThubjcwZWhic2hsNzhpcWpsY3Z0OGdkODc4Ni5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbSIsInByb3ZpZGVyIjoiZ29vZ2xlIn0%3D"},{"url":"https://login.microsoftonline.com/common/oauth2/v2.0/authorize","photoUrl":"https://graph.microsoft.com/v1.0/me/photo/$value","name":"microsoft","friendly_name":"Office 365","params":{"client_id":"2ab5382e-4b5a-440f-9e67-20e265b41c58","response_type":"code","include_granted_scopes":true,"scope":"openid profile email User.Read","redirect_uri":"http://localhost:3000","state":"eyJjbGllbnRfaWQiOiIyYWI1MzgyZS00YjVhLTQ0MGYtOWU2Ny0yMGUyNjViNDFjNTgiLCJwcm92aWRlciI6Im1pY3Jvc29mdCJ9"},"link_url":"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=2ab5382e-4b5a-440f-9e67-20e265b41c58&response_type=code&include_granted_scopes=true&scope=openid+profile+email+User.Read&redirect_uri=http%3A%2F%2Flocalhost:3000&state=eyJjbGllbnRfaWQiOiIyYWI1MzgyZS00YjVhLTQ0MGYtOWU2Ny0yMGUyNjViNDFjNTgiLCJwcm92aWRlciI6Im1pY3Jvc29mdCJ9"},{"url":"https://login.salesforce.com/services/oauth2/authorize","authenticate_photoUrl":false,"name":"salesforce","friendly_name":"Sales Force","params":{"client_id":"3MVG9i1HRpGLXp.qZwLB6u.b4FJi5bibPWMricI6mhR5IjeRmvk9n7C29buhZ0rDSllC_f.GOKduaF8ApJenh","response_type":"code","include_granted_scopes":true,"scope":"openid api id refresh_token web","redirect_uri":"http://localhost:3000","state":"eyJjbGllbnRfaWQiOiIzTVZHOWkxSFJwR0xYcC5xWndMQjZ1LmI0RkppNWJpYlBXTXJpY0k2bWhSNUlqZVJtdms5bjdDMjlidWhaMHJEU2xsQ19mLkdPS2R1YUY4QXBKZW5oIiwicHJvdmlkZXIiOiJzYWxlc2ZvcmNlIn0="},"link_url":"https://login.salesforce.com/services/oauth2/authorize?client_id=3MVG9i1HRpGLXp.qZwLB6u.b4FJi5bibPWMricI6mhR5IjeRmvk9n7C29buhZ0rDSllC_f.GOKduaF8ApJenh&response_type=code&include_granted_scopes=true&scope=openid+api+id+refresh_token+web&redirect_uri=http%3A%2F%2Flocalhost:3000&state=eyJjbGllbnRfaWQiOiIzTVZHOWkxSFJwR0xYcC5xWndMQjZ1LmI0RkppNWJpYlBXTXJpY0k2bWhSNUlqZVJtdms5bjdDMjlidWhaMHJEU2xsQ19mLkdPS2R1YUY4QXBKZW5oIiwicHJvdmlkZXIiOiJzYWxlc2ZvcmNlIn0%3D"},{"url":"https://www.linkedin.com/uas/oauth2/authorization","name":"linkedin","friendly_name":"Linked in","params":{"client_id":"78xd6e4jp3r3gi","response_type":"code","include_granted_scopes":true,"scope":"r_emailaddress r_basicprofile","redirect_uri":"http://localhost:3000","state":"eyJjbGllbnRfaWQiOiI3OHhkNmU0anAzcjNnaSIsInByb3ZpZGVyIjoibGlua2VkaW4ifQ=="},"authenticate_photoUrl":false,"link_url":"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=2ab5382e-4b5a-440f-9e67-20e265b41c58&response_type=code&include_granted_scopes=true&scope=openid+profile+email+User.Read&redirect_uri=https%3A%2F%2Fmonster.sandbox.2600hz.com&state=eyJjbGllbnRfaWQiOiIyYWI1MzgyZS00YjVhLTQ0MGYtOWU2Ny0yMGUyNjViNDFjNTgiLCJwcm92aWRlciI6Im1pY3Jvc29mdCJ9"}];
			var self = this,
				ssoUser = $.parseJSON($.cookie('monster-sso-auth')) || {},
				dataTemplate = {
					ssoProviders: monster.config.whitelabel.sso_providers || [],
					ssoUser: ssoUser,
					isUnknownKazooUser: ssoUser.hasOwnProperty('auth_app_id') && !ssoUser.hasOwnProperty('account_id')
				},
				template = $(monster.template(self, 'sso-providers', dataTemplate));

			$(container).empty();

			self.bindSSOPhotoUrl(dataTemplate, template);

			template.find('.kill-sso-session').on('click', function() {
				monster.util.resetAuthCookies();

				self.renderSSOProviderTemplate(container);
			});

			template.find('.sso-button').on('click', function() {
				self.clickSSOProviderLogin({
					provider: $(this).data('provider'),
					forceSamePage: false,
					error: function(errorCode, errorData, decodedData) {
						if (errorCode === '_no_account_linked') {
							console.log(errorCode, errorData, decodedData);
							//window.location.href = window.location.protocol + '//' + window.location.host;

							self.renderSSOProviderTemplate(container);
						}
					}
				});
			});

			$(container).append(template);
		},

		bindSSOPhotoUrl: function(templateData, container) {
			var self = this,
				ssoUser = templateData.ssoUser,
				content = container;

			if (templateData.isUnknownKazooUser) {
				var token = ssoUser.auth_app_token_type + ' ' + ssoUser.auth_app_token;

				if (ssoUser.hasOwnProperty('photoUrl')) {
					var provider = self.findSSOPhotoUrlProvider(templateData);

					if (provider.hasOwnProperty('authenticate_photoUrl') && !provider.authenticate_photoUrl) {
						self.paintSSOImgElement(content, ssoUser.photoUrl);
					} else {
						self.requestPhotoFromUrl(ssoUser.photoUrl, token, container);
					}
				} else {
					self.findSSOPhotoUrlFromProvider(templateData, container);
				}
			}
		},

		renderLoginPage: function() {
			var self = this,
				container = self.appFlags.mainContainer,
				accountName = '',
				realm = '',
				cookieLogin = $.parseJSON($.cookie('monster-login')) || {},
				templateData = {
					username: cookieLogin.login || '',
					requestAccountName: (realm || accountName) ? false : true,
					accountName: cookieLogin.accountName || '',
					rememberMe: cookieLogin.login || cookieLogin.accountName ? true : false,
					showRegister: monster.config.hide_registration || false,
					hidePasswordRecovery: monster.config.whitelabel.hidePasswordRecovery || false
				},
				template = $(monster.template(self, 'app', templateData)),
				loadWelcome = function() {
					if (monster.config.whitelabel.custom_welcome) {
						template.find('.welcome-message').empty().html((monster.config.whitelabel.custom_welcome_message || '').replace(/\r?\n/g, '<br />'));
					}

					container.append(template);
					self.bindLoginBlock(templateData);
					template.find('.powered-by-block').append($('.core-footer .powered-by'));
				},
				domain = window.location.hostname;

			self.renderSSOProviderTemplate(template.find('.sso-providers-wrapper'));

			self.callApi({
				resource: 'whitelabel.getLogoByDomain',
				data: {
					domain: domain,
					generateError: false,
					dataType: '*'
				},
				success: function(_data) {
					template.find('.logo-block').css('background-image', 'url(' + monster.config.api.default + 'whitelabel/' + domain + '/logo?_=' + new Date().getTime() + ')');
					loadWelcome();
				},
				error: function(error) {
					template.find('.logo-block').css('background-image', 'url("apps/auth/style/static/images/logo.svg")');
					loadWelcome();
				}
			});
		},

		paintSSOImgElement: function(container, src) {
			var self = this,
				imageElm = document.createElement('img');

			imageElm.className = 'sso-user-photo';
			imageElm.src = src;

			container.find('.sso-user-photo-div').append(imageElm);
		},

		requestPhotoFromUrl: function(photoUrl, token, container) {
			var self = this,
				content = container,
				defaultPhotoUrl = 'apps/auth/style/oauth/no_photo_url.png';

			var request = new XMLHttpRequest();
			request.open('GET', photoUrl);

			request.setRequestHeader('Authorization', token);
			request.responseType = 'blob';

			request.onload = function() {
				if (request.readyState === 4 && request.status === 200) {
					var reader = new FileReader();
					reader.onload = function() {
						self.paintSSOImgElement(content, reader.result);
					};
					reader.readAsDataURL(request.response);
				} else {
					self.paintSSOImgElement(content, defaultPhotoUrl);
				}
			};
			request.send(null);
		},

		findSSOPhotoUrlFromProvider: function(templateData, container) {
			var self = this,
				ssoUser = templateData.ssoUser,
				ssoProvider = ssoUser.auth_provider,
				token = ssoUser.auth_app_token_type + ' ' + ssoUser.auth_app_token,
				ssoProviders = templateData.ssoProviders,
				content = container,
				defaultPhotoUrl = 'style/oauth/no_photo_url.png';

			_.each(ssoProviders, function(provider) {
				if (provider.name === ssoProvider) {
					if (provider.hasOwnProperty('photoUrl')) {
						self.requestPhotoFromUrl(provider.photoUrl, token, container);
					} else {
						content.find('.sso-user-photo').src = defaultPhotoUrl;
					}
				}
			});
		},

		findSSOPhotoUrlProvider: function(templateData) {
			var self = this,
				ssoName = templateData.ssoUser.auth_provider,
				ssoProviders = templateData.ssoProviders,
				ssoProvider = {};

			_.each(ssoProviders, function(provider) {
				if (provider.name === ssoName) {
					ssoProvider = $.extend(true, {}, provider);
				}
			});
			return ssoProvider;
		},

		addSSOConnection: function(data) {
			console.log(data);
		},

		clickSSOProviderLogin: function(params) {
			var self = this,
				type = params.provider,
				updateLayout = params.updateLayout || true,
				forceSamePage = typeof params.forceSamePage !== 'undefined' ? params.forceSamePage : false;

			self.loginToSSOProvider(type, forceSamePage, function(data) {
				// If it uses the same page mechanism, this callback will be executed.
				// If not, then the page is refreshed and the data will be captured by the login mechanism
				var decodedData = self.buildCookiesFromSSOResponse(data);
				//self.addSSOConnection(authData);

				self.authenticateAuthToken(data.auth_token, function(authData) {
					self._afterSuccessfulAuth(authData, updateLayout);
				}, function(data) {
					if (data.httpErrorStatus === 403) {
						params.error && params.error('_no_account_linked', data, decodedData);
					} else {
						params.error && params.error('_unknown', data);
					}
				});
			}, function(errorCode) {
				console.log(errorCode);
			});
		},

		updateLayoutWithSSOUser: function(template, data) {
			var self = this;

			console.log(template, data);
		},

		bindLoginBlock: function(templateData) {
			var self = this,
				content = $('#auth_container');

			content.find(templateData.username !== '' ? '#password' : '#login').focus();

			content.find('.btn-submit.login').on('click', function(e) {
				e.preventDefault();

				self.loginClick();
			});

			// New Design stuff
			if (content.find('.input-wrap input[type="text"], input[type="password"], input[type="email"]').val() !== '') {
				content.find('.placeholder-shift').addClass('fixed');
			}

			content.find('.input-wrap input').on('focus', function() {
				content.find('.input-wrap').removeClass('error');
				content.find('.error-message-wrapper').hide();
				content.find('.error-message-wrapper').find('.text').html('');
			});

			content.find('.input-wrap input[type="text"], input[type="password"], input[type="email"]').on('change', function() {
				if (this.value !== '') {
					$(this).next('.placeholder-shift').addClass('fixed');
				} else {
					$(this).next('.placeholder-shift').removeClass('fixed');
				}
			});

			// ----------------
			// FORM TYPE TOGGLE
			// ----------------

			content.find('.form-toggle').on('click', function() {
				var formType = $(this).data('form');

				content.find('.form-container').toggleClass('hidden');
				content.find('.form-container[data-form="' + formType + '"]').addClass('fadeInDown');

				content.find('.form-content').removeClass('hidden');
				content.find('.reset-notification').addClass('hidden');
			});

			// ------------------------
			// PASSWORD RECOVERY SUBMIT
			// ------------------------
			var form = content.find('#form_password_recovery');

			monster.ui.validate(form);

			content.find('.recover-password').on('click', function() {
				if (monster.ui.valid(form)) {
					var object = monster.ui.getFormData('form_password_recovery', '.', true);

					object.ui_url = window.location.href;

					if (object.hasOwnProperty('account_name') || object.hasOwnProperty('phone_number')) {
						self.callApi({
							resource: 'auth.recovery',
							data: {
								data: object,
								generateError: false
							},
							success: function(data, success) {
								content.find('.form-content').addClass('hidden');
								content.find('.reset-notification').addClass('animated fadeIn').removeClass('hidden');
							},
							error: function(data, error, globalHandler) {
								if (error.status === 400) {
									_.keys(data.data).forEach(function(val) {
										if (self.i18n.active().recoverPassword.toastr.error.reset.hasOwnProperty(val)) {
											toastr.error(self.i18n.active().recoverPassword.toastr.error.reset[val]);
										} else {
											if (data.data[val].hasOwnProperty('not_found')) {
												toastr.error(data.data[val].not_found);
											}
										}
									});
								} else {
									globalHandler(data);
								}
							}
						});
					} else {
						toastr.error(self.i18n.active().recoverPassword.toastr.error.missing);
					}
				}
			});
		},

		loginClick: function(data) {
			var self = this,
				loginUsername = $('#login').val(),
				loginPassword = $('#password').val(),
				loginAccountName = $('#account_name').val(),
				hashedCreds = $.md5(loginUsername + ':' + loginPassword),
				loginData = {
					credentials: hashedCreds,
					account_name: loginAccountName
				};

			if (loginUsername && loginPassword) {
				self.putAuth(loginData, function(data) {
					if ($('#remember_me').is(':checked')) {
						var cookieLogin = {
							login: loginUsername,
							accountName: loginAccountName
						};

						$.cookie('monster-login', JSON.stringify(cookieLogin), {expires: 30});
					} else {
						$.cookie('monster-login', null);
					}
				},
				function() {
					$('#login, #password, #account_name').parents('.input-wrap').addClass('error');
					$('.error-message-wrapper').find('.text').html(self.i18n.active().invalidCredentials);
					$('.error-message-wrapper').show();
				});
			} else {
				if (!loginUsername) {
					$('#login').parents('.input-wrap').addClass('error');
				}
				if (!loginPassword) {
					$('#password').parents('.input-wrap').addClass('error');
				}
			}
		},

		_logout: function() {
			var self = this;

			monster.util.logoutAndReload();
		},

		newPassword: function(userData) {
			var self = this,
				template = $(monster.template(self, 'dialogPasswordUpdate')),
				form = template.find('#form_password_update'),
				popup = monster.ui.dialog(template, { title: self.i18n.active().passwordUpdate.title });

			monster.ui.validate(form);

			template.find('.update-password').on('click', function() {
				if (monster.ui.valid(form)) {
					var formData = monster.ui.getFormData('form_password_update');

					if (formData.new_password === formData.new_password_confirmation) {
						var newUserData = {
								password: formData.new_password,
								require_password_update: false
							},
							data = $.extend(true, {}, userData, newUserData);

						self.callApi({
							resource: 'user.update',
							data: {
								accountId: self.accountId,
								userId: self.userId,
								data: data
							},
							success: function(data, status) {
								popup.dialog('close').remove();
								toastr.success(self.i18n.active().passwordUpdate.toastr.success.update);
							}
						});
					} else {
						toastr.error(self.i18n.active().passwordUpdate.toastr.error.password);
					}
				}
			});

			template.find('.cancel-link').on('click', function() {
				popup.dialog('close').remove();
			});
		},

		checkRecoveryId: function(recoveryId, callback) {
			var self = this;

			self.recoveryWithResetId({ reset_id: recoveryId }, function(data) {
				if (data.hasOwnProperty('auth_token') && data.data.hasOwnProperty('account_id')) {
					callback && callback(data);
				} else {
					self.renderLoginPage();
				}
			},
			function() {
				self.renderLoginPage();
			});
		},

		recoveryWithResetId: function(dataRecovery, success, error) {
			var self = this;

			self.callApi({
				resource: 'auth.recoveryResetId',
				data: {
					accountId: self.accountId,
					data: dataRecovery,
					generateError: false
				},
				success: function(data) {
					success && success(data);
				},
				error: function(errorPayload, data, globalHandler) {
					if (data.status === 401 && errorPayload.data.hasOwnProperty('multi_factor_request')) {
						self.handleMultiFactor(errorPayload.data, dataRecovery, function(augmentedDataRecovery) {
							self.recoveryWithResetId(augmentedDataRecovery, success, error);
						}, function() {
							monster.util.logoutAndReload();
						});
					} else {
						globalHandler(data, { generateError: true });
					}
				}
			});
		},

		unlinkUserSSO: function(authId, callback) {
			var self = this;

			self.callApi({
				resource: 'auth.unlink',
				data: {
					auth_id: authId
				},
				success: function(data) {
					toastr.success(self.i18n.active().ssoSuccessUnlinking);
					callback && callback(data.data);
				},
				error: function(data) {
					toastr.error(self.i18n.active().ssoFailedUnlinking);
					callback && callback(data.data);
				}
			});
		},

		linkUserSSO: function(authId, callback) {
			var self = this;

			self.callApi({
				resource: 'auth.link',
				data: {
					auth_id: authId
				},
				success: function(data) {
					toastr.success(self.i18n.active().ssoSuccessLinking);
					callback && callback(data.data);
				},
				error: function(data) {
					toastr.error(self.i18n.active().ssoFailedLinking);
					callback && callback(data.data);
				}
			});
		},

		// API Calls
		putAuth: function(loginData, callback, wrongCredsCallback, pUpdateLayout, additionalArgs) {
			var self = this,
				dataPayload = $.extend(true, {
					data: loginData,
					generateError: false
				}, additionalArgs || {});

			self.callApi({
				resource: 'auth.userAuth',
				data: dataPayload,
				success: function(data, status) {
					var ssoUser = $.parseJSON($.cookie('monster-sso-auth')) || {};

					data.loginData = loginData;

					self._afterSuccessfulAuth(data, pUpdateLayout);

					if (ssoUser.hasOwnProperty('auth_id')) {
						self.linkUserSSO(ssoUser.auth_id, function() {
							callback && callback(data);
						});
					} else {
						callback && callback(data);
					}
				},
				error: function(errorPayload, data, globalHandler) {
					if (data.status === 423 && errorPayload.data.hasOwnProperty('account') && errorPayload.data.account.hasOwnProperty('expired')) {
						var date = monster.util.toFriendlyDate(monster.util.gregorianToDate(errorPayload.data.account.expired.cause), 'date'),
							errorMessage = monster.template(self, '!' + self.i18n.active().expiredTrial, { date: date });

						monster.ui.alert('warning', errorMessage);
					} else if (data.status === 423) {
						monster.ui.alert('error', self.i18n.active().disabledAccount);
					} else if (data.status === 401) {
						if (errorPayload.data.hasOwnProperty('multi_factor_request')) {
							self.handleMultiFactor(errorPayload.data, loginData, function(augmentedLoginData) {
								self.putAuth(augmentedLoginData, callback, wrongCredsCallback, pUpdateLayout, additionalArgs);
							}, wrongCredsCallback);
						} else {
							wrongCredsCallback && wrongCredsCallback();
						}
					} else {
						globalHandler(data, { generateError: true });
					}
				}
			});
		},

		handleMultiFactor: function(data, loginData, success, error) {
			var self = this;

			if (data.multi_factor_request.provider_name === 'duo') {
				self.showDuoDialog(data, loginData, success, error);
			} else {
				error && error();
			}
		},

		showDuoDialog: function(data, loginData, success, error) {
			var self = this,
				wasSuccessful = false;

			require(['duo'], function() {
				var template = self.getTemplate({ name: 'duo-dialog' }),
					dialog = monster.ui.dialog(template, {
						title: self.i18n.active().duoDialog.title,
						onClose: function() {
							if (!wasSuccessful) {
								error && error();
							}
						}
					});

				Duo.init({
					iframe: dialog.find('iframe')[0],
					sig_request: data.multi_factor_request.settings.duo_sig_request,
					host: data.multi_factor_request.settings.duo_api_hostname,
					submit_callback: function(form) {
						wasSuccessful = true;
						loginData.multi_factor_response = $(form).find('[name="sig_response"]').attr('value');
						dialog.dialog('close').remove();
						success && success(loginData);
					}
				});
			});
		},

		retryLogin: function(additionalArgs, success, error) {
			var self = this,
				loginData;

			if ($.cookie('monster-auth')) {
				var cookieData = $.parseJSON($.cookie('monster-auth'));

				if (cookieData.hasOwnProperty('credentials') && cookieData.hasOwnProperty('accountName')) {
					loginData = {
						credentials: cookieData.credentials,
						account_name: cookieData.accountName
					};
				}
			}

			if (loginData) {
				self.putAuth(loginData, function(data) {
					success && success(data.auth_token);
				}, error, false, additionalArgs);
			} else {
				error && error();
			}
		},

		recovery: function(recoveryId, success, error) {
			var self = this;

			self.callApi({
				resource: 'auth.recovery',
				data: {
					accountId: self.accountId,
					recoveryId: recoveryId
				},
				success: function(data) {
					success && success(data.data);
				},
				error: function() {
					error && error();
				}
			});
		},

		getAuth: function(authToken, callbackSuccess, callbackError) {
			var self = this;

			self.callApi({
				resource: 'auth.postTokenInfo',
				data: {
					data: {
						token: authToken
					},
					generateError: false
				},
				success: function(data) {
					callbackSuccess && callbackSuccess(data);
				},
				error: function(error) {
					callbackError && callbackError(error);
				}
			});
		},

		putAuthCallback: function(odata, callbackSuccess, callbackError) {
			var self = this;

			self.callApi({
				resource: 'auth.callback',
				data: {
					data: odata,
					generateError: false
				},
				success: function(data) {
					callbackSuccess && callbackSuccess(data);
				},
				error: function(error) {
					callbackError && callbackError(error);
				}
			});
		},

		getAccount: function(accountId, success, error) {
			var self = this;

			self.callApi({
				resource: 'account.get',
				data: {
					accountId: accountId
				},
				success: function(_data) {
					if (typeof success === 'function') {
						success(_data);
					}
				},
				error: function(err) {
					if (typeof error === 'function') {
						error(err);
					}
				}
			});
		},

		getAppsStore: function(callback) {
			var self = this;

			self.callApi({
				resource: 'appsStore.list',
				data: {
					accountId: self.accountId
				},
				success: function(_data) {
					callback && callback(_data.data);
				}
			});
		},

		getUser: function(success, error) {
			var self = this;

			self.callApi({
				resource: 'user.get',
				data: {
					accountId: self.accountId,
					userId: self.userId
				},
				success: function(_data) {
					if (typeof success === 'function') {
						success(_data);
					}
				},
				error: function(err) {
					if (typeof error === 'function') {
						error(err);
					}
				}
			});
		},

		// Method used to authenticate other apps
		_initApp: function(args) {
			var self = this,
				success = function(app) {
					// If isMasqueradable flag is set in the code itself, use it, otherwise check if it's set in the DB, otherwise defaults to true
					app.isMasqueradable = app.hasOwnProperty('isMasqueradable') ? app.isMasqueradable : (monster.appsStore.hasOwnProperty(app.name) ? monster.appsStore[app.name].masqueradable : true);
					app.accountId = app.isMasqueradable && self.currentAccount ? self.currentAccount.id : self.accountId;
					app.userId = self.userId;

					args.callback && args.callback();
				},
				installedApp = _.find(self.installedApps, function(val) {
					return val.name === args.app.name;
				});

			if (installedApp && installedApp.api_url) {
				args.app.apiUrl = installedApp.api_url;
				if (args.app.apiUrl.substr(args.app.apiUrl.length - 1) !== '/') {
					args.app.apiUrl += '/';
				}
			}

			success(args.app);
		},

		loginToSSOProvider: function(providerName, forceSamePage, success, error) {
			var self = this,
				providers = _.filter(monster.config.whitelabel.sso_providers, function(provider) {
					return provider.name === providerName;
				}),
				provider = providers.length ? providers[0] : '_no_provider';

			if (provider !== '_no_provider') {
				if (forceSamePage) {
					window.location = provider.link_url;
				} else {
					monster.ui.popupRedirect(provider.link_url, provider.params.redirect_uri, {}, function(params) {
						self.getNewOAuthTokenFromURLParams(params, success);
					}, function() {
						error && error('_oAuthPopup_error');
					});
				}
			} else {
				error && error('_invalid_provider');
			}
		}
	};

	return app;
});
