import { type RequestHandler } from 'express';
import { allowSecretKinds } from '../middlewares/responseFormatter.js';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import jwt from 'jsonwebtoken';
import { User } from '../classes/index.js';
import { environment } from '../config/environment.js';
import { Workspace } from '../classes/workspace/index.js';
import type { CognitoJwtPayload } from '../types/express.js';
import type { EmptySuccessResponseData } from '../types/response.js';
import type {
  SignupRequestBody,
  SignupResponseData,
  ConfirmSignupRequestBody,
  ResendConfirmationRequestBody,
  LoginRequestBody,
  LoginResponseData,
  ForgotPasswordRequestBody,
  ResetPasswordRequestBody,
  RefreshTokenRequestBody,
  RefreshTokenResponseData,
} from '../routes/public/auth/index.js';

const EMPTY: EmptySuccessResponseData = {};

/** The Cognito exception's name, if it is one. Its message is never sent: it can quote the input. */
function cognitoErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** Answers that never quote the request: one generic message and a machine code per case. */
const INVALID_CREDENTIALS = 'Incorrect email or password.';
const PASSWORD_POLICY = 'The password does not meet the requirements.';
const CODE_INVALID = 'The verification code is not valid.';
const CODE_EXPIRED = 'The verification code has expired. Request a new one.';

const cognitoClient = new CognitoIdentityProviderClient({
  region: environment.awsRegion,
});

const signup: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { email, password, name } = req.body as SignupRequestBody;

    if (!email || !password || !name) {
      res.error('Email, password, and name are required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    const result = await cognitoClient.send(
      new SignUpCommand({
        ClientId: clientId,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: name },
        ],
      }),
    );

    const data: SignupResponseData = {
      userSub: result.UserSub ?? '',
      userConfirmed: result.UserConfirmed ?? false,
    };

    res.success(data);
  } catch (error) {
    console.error('Signup error:', error);
    switch (cognitoErrorName(error)) {
      case 'UsernameExistsException':
        res.error('An account with this email already exists.', 400, 'user_exists');
        return;
      case 'InvalidPasswordException':
        res.error(PASSWORD_POLICY, 400, 'password_policy');
        return;
      default:
        res.error('Sign-up failed. Check your details and try again.', 400);
    }
  }
};

const confirmSignup: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { email, code } = req.body as ConfirmSignupRequestBody;

    if (!email || !code) {
      res.error('Email and verification code are required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    await cognitoClient.send(
      new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: email,
        ConfirmationCode: code,
      }),
    );

    res.success(EMPTY);
  } catch (error) {
    console.error('Confirmation error:', error);
    switch (cognitoErrorName(error)) {
      case 'CodeMismatchException':
        res.error(CODE_INVALID, 400, 'code_invalid');
        return;
      case 'ExpiredCodeException':
        res.error(CODE_EXPIRED, 400, 'code_expired');
        return;
      default:
        res.error('Email verification failed. Please try again.', 400);
    }
  }
};

const resendConfirmation: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { email } = req.body as ResendConfirmationRequestBody;

    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    if (trimmedEmail === '') {
      res.error('Email is required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    await cognitoClient.send(
      new ResendConfirmationCodeCommand({
        ClientId: clientId,
        Username: trimmedEmail,
      }),
    );

    res.success(EMPTY);
  } catch (error: unknown) {
    console.error('Resend confirmation error:', error);

    if (error instanceof Error) {
      if (error.name === 'UserNotFoundException') {
        res.success(EMPTY);
        return;
      }

      if (error.name === 'InvalidParameterException' || error.name === 'NotAuthorizedException') {
        res.error('This email is already verified. You can sign in with your password.', 400);
        return;
      }

      if (error.name === 'LimitExceededException') {
        res.error('Too many requests. Please try again later.', 429);
        return;
      }
    }

    res.error('Failed to resend verification code. Please try again.', 500);
  }
};

const login: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { email, password } = req.body as LoginRequestBody;

    if (!email || !password) {
      res.error('Email and password are required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    const result = await cognitoClient.send(
      new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    );

    const idToken = result.AuthenticationResult?.IdToken;
    const refreshToken = result.AuthenticationResult?.RefreshToken;
    const expiresIn = result.AuthenticationResult?.ExpiresIn;

    if (idToken === undefined) {
      throw new Error('No ID token received from Cognito');
    }

    const decoded = jwt.decode(idToken) as CognitoJwtPayload | null;
    if (decoded === null) {
      throw new Error('Invalid token: missing sub claim');
    }

    const cognitoSub = decoded.sub;
    const userEmail = decoded.email ?? null;
    const userName = decoded.name ?? null;

    const user = await User.upsertFromLogin(cognitoSub, userEmail, userName);

    const data: LoginResponseData = {
      user: {
        id: user.cognitoSub,
        email: user.email ?? '',
        name: user.name ?? '',
      },
      tokens: {
        idToken,
        refreshToken: refreshToken ?? '',
        expiresIn: expiresIn ?? 3600,
      },
      // No workspace is created here: onboarding does that.
      ...(await Workspace.statusFor(user)),
    };

    allowSecretKinds(res, 'jwt'); // the user's own session tokens
    res.success(data);
  } catch (error: unknown) {
    console.error('Login error:', error);

    switch (cognitoErrorName(error)) {
      case 'UserNotConfirmedException':
        res.error('Please verify your email before signing in.', 403, 'email_unverified');
        return;
      case 'NotAuthorizedException':
      case 'UserNotFoundException':
        // One answer for both, so the response doesn't reveal which emails have an account.
        res.error(INVALID_CREDENTIALS, 401, 'invalid_credentials');
        return;
      default:
        res.error('Login failed. Please try again.', 401);
    }
  }
};

const forgotPassword: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { email } = req.body as ForgotPasswordRequestBody;

    if (!email) {
      res.error('Email is required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    await cognitoClient.send(
      new ForgotPasswordCommand({
        ClientId: clientId,
        Username: email,
      }),
    );

    res.success(EMPTY);
  } catch (error: unknown) {
    console.error('Forgot password error:', error);

    if (error instanceof Error) {
      if (error.name === 'UserNotFoundException') {
        res.success(EMPTY);
        return;
      }

      if (error.name === 'LimitExceededException') {
        res.error('Too many requests. Please try again later.', 429);
        return;
      }
    }

    res.error('Failed to initiate password reset. Please try again.', 500);
  }
};

const resetPassword: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { email, code, password } = req.body as ResetPasswordRequestBody;

    if (!email || !code || !password) {
      res.error('Email, verification code, and new password are required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    await cognitoClient.send(
      new ConfirmForgotPasswordCommand({
        ClientId: clientId,
        Username: email,
        ConfirmationCode: code,
        Password: password,
      }),
    );

    res.success(EMPTY);
  } catch (error: unknown) {
    console.error('Reset password error:', error);

    if (error instanceof Error) {
      if (error.name === 'CodeMismatchException') {
        res.error(CODE_INVALID, 400, 'code_invalid');
        return;
      }

      if (error.name === 'ExpiredCodeException') {
        res.error(CODE_EXPIRED, 400, 'code_expired');
        return;
      }

      if (error.name === 'InvalidPasswordException') {
        res.error(PASSWORD_POLICY, 400, 'password_policy');
        return;
      }

      if (error.name === 'LimitExceededException') {
        res.error('Too many attempts. Please try again later.', 429);
        return;
      }
    }

    res.error('Failed to reset password. Please try again.', 500);
  }
};

const refreshTokenHandler: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { refreshToken } = req.body as RefreshTokenRequestBody;

    if (!refreshToken || refreshToken === '') {
      res.error('Refresh token is required', 400);
      return;
    }

    const clientId = environment.cognitoClientId;

    const response = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      }),
    );

    if (response.AuthenticationResult === undefined) {
      res.error('Failed to refresh tokens', 401);
      return;
    }

    const { IdToken, ExpiresIn } = response.AuthenticationResult;

    if (IdToken === undefined) {
      res.error('Failed to refresh tokens', 401);
      return;
    }

    const data: RefreshTokenResponseData = {
      idToken: IdToken,
      expiresIn: ExpiresIn ?? 3600,
    };

    allowSecretKinds(res, 'jwt'); // the user's own session tokens
    res.success(data);
  } catch (error: unknown) {
    console.error('Token refresh failed:', error);

    if (error instanceof Error) {
      if (error.name === 'NotAuthorizedException') {
        res.error('Refresh token expired or invalid', 401);
        return;
      }

      if (error.name === 'UserNotFoundException') {
        res.error('User not found', 401);
        return;
      }
    }

    res.error('Failed to refresh tokens', 500);
  }
};

export const AuthController = {
  signup,
  confirmSignup,
  resendConfirmation,
  login,
  forgotPassword,
  resetPassword,
  refreshToken: refreshTokenHandler,
} as const;
