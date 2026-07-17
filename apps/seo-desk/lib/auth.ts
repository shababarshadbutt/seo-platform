import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { connectDB, User } from "@/lib/mongodb";

// Only use Secure/__Secure- cookies when actually served over HTTPS. The
// production build runs over http://localhost:4000 in local Docker, and browsers
// reject Secure cookies on plain HTTP — which caused an endless redirect back to
// /login. Key both the cookie name and the `secure` flag off the scheme of
// NEXTAUTH_URL so HTTPS deployments keep their hardened cookies.
const useSecureCookies = (process.env.NEXTAUTH_URL ?? "").startsWith("https://");

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: 60 * 60,      // JWT expires after 1 hour
    updateAge: 15 * 60,   // Refresh JWT every 15 minutes if active
  },
  cookies: {
    sessionToken: {
      name: useSecureCookies
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: useSecureCookies,
        // No maxAge → session cookie → deleted when browser closes
      },
    },
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Email and password are required");
        }

        await connectDB();

        const user = await User.findOne({
          email: credentials.email.toLowerCase(),
          isActive: true,
        }).lean();

        if (!user) {
          throw new Error("Invalid email or password");
        }

        const isValid = await bcrypt.compare(credentials.password, user.password);
        if (!isValid) {
          throw new Error("Invalid email or password");
        }

        return {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
      }
      // Re-fetch role from DB so permission changes take effect without re-login
      if (token.id) {
        try {
          await connectDB();
          const fresh = await User.findById(token.id).select("role isActive").lean();
          if (fresh) token.role = fresh.role;
        } catch {
          // DB unavailable — keep existing token data, don't crash the request
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Expose id and role on the client-side session object
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
};
