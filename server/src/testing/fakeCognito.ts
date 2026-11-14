/**
 * Test-only: Cognito's user-pool API as the auth routes call it (controllers/auth.ts), in this
 * process. Any email address signs up (unconfirmed) and signs in with FAKE_COGNITO_PASSWORD only,
 * like a real account with that password; the ID token is a test token (testAuth.ts), which the
 * test verifier accepts, so sign-in runs end to end through the real controllers with no AWS
 * call. Verification and reset codes are always wrong, and a refresh token is never valid.
 * Account deletion succeeds.
 */
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { defaultNameFor, mintTestToken, testSubForEmail } from './testAuth.js';

/** The one password every account has. */
export const FAKE_COGNITO_PASSWORD = 'FAKE-Passw0rd!';

/** What Cognito takes as a user name here: one email address. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A Cognito exception as the SDK throws it: only its name matters to the controllers. */
function cognitoError(name: string): Error {
  const error = new Error(`${name} (fake Cognito)`);
  error.name = name;
  return error;
}

function answer(command: unknown): unknown {
  if (command instanceof SignUpCommand) {
    const email = command.input.Username ?? '';
    if (!EMAIL.test(email)) throw cognitoError('InvalidParameterException');
    if (command.input.Password !== FAKE_COGNITO_PASSWORD) {
      throw cognitoError('InvalidPasswordException');
    }
    return { UserSub: testSubForEmail(email), UserConfirmed: false };
  }
  if (command instanceof InitiateAuthCommand) {
    if (command.input.AuthFlow !== 'USER_PASSWORD_AUTH')
      throw cognitoError('NotAuthorizedException');
    const email = (command.input.AuthParameters?.['USERNAME'] ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw cognitoError('UserNotFoundException');
    if (command.input.AuthParameters?.['PASSWORD'] !== FAKE_COGNITO_PASSWORD) {
      throw cognitoError('NotAuthorizedException');
    }
    const identity = { sub: testSubForEmail(email), email, name: defaultNameFor(email) };
    return {
      AuthenticationResult: {
        IdToken: mintTestToken(identity),
        RefreshToken: 'FAKE-refresh-token',
        ExpiresIn: 3600,
      },
    };
  }
  if (command instanceof ConfirmSignUpCommand || command instanceof ConfirmForgotPasswordCommand) {
    throw cognitoError('CodeMismatchException');
  }
  if (
    command instanceof ResendConfirmationCodeCommand ||
    command instanceof ForgotPasswordCommand ||
    command instanceof AdminDeleteUserCommand
  ) {
    return {};
  }
  throw new Error('fake Cognito: a command it does not stand in for');
}

/** Replaces every Cognito client's `send`; returns the restore. */
export function installFakeCognito(): () => void {
  const proto = CognitoIdentityProviderClient.prototype as unknown as {
    send: (command: unknown) => Promise<unknown>;
  };
  const original = proto.send;
  proto.send = (command: unknown): Promise<unknown> => {
    try {
      return Promise.resolve(answer(command));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return (): void => {
    proto.send = original;
  };
}
