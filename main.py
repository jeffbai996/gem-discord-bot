import os
import discord
import io
import mimetypes
from dotenv import load_dotenv
from google import genai
from google.genai import types
from tools import TOOLS, TOOL_DECLARATIONS

# Load environment variables
load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not DISCORD_TOKEN or not GEMINI_API_KEY:
    print("Error: DISCORD_TOKEN and GEMINI_API_KEY must be set in .env")
    exit(1)

# Initialize Gemini Client
client = genai.Client(api_key=GEMINI_API_KEY)
MODEL_ID = "gemini-2.5-flash"

# Set up Discord intents
intents = discord.Intents.default()
intents.message_content = True  # Required to read message content

class GeminiBot(discord.Client):
    async def on_ready(self):
        # Set bot presence
        activity = discord.Activity(type=discord.ActivityType.listening, name="your requests")
        await self.change_presence(status=discord.Status.online, activity=activity)
        print(f'Logged in as {self.user} (ID: {self.user.id})')
        print('------')

    async def on_message(self, message):
        # Ignore messages from the bot itself
        if message.author == self.user:
            return

        is_in_thread = isinstance(message.channel, discord.Thread)
        bot_mentioned = self.user in message.mentions

        # 1. Start a new thread if mentioned in a regular channel
        if not is_in_thread and bot_mentioned:
            thread_name = f"Chat with {message.author.display_name}"
            thread = await message.create_thread(name=thread_name, auto_archive_duration=60)
            await self.process_gemini_request(thread, message)
            return

        # 2. Respond in a thread owned by the bot
        if is_in_thread and (message.channel.owner_id == self.user.id or bot_mentioned):
            await self.process_gemini_request(message.channel, message)

    async def process_gemini_request(self, channel, trigger_message):
        """Main loop for generating content, handling attachments and tool calls."""
        # Initial status: reaction
        try:
            await trigger_message.add_reaction("⏳")
        except discord.Forbidden:
            pass # No permissions for reactions

        async with channel.typing():
            try:
                # Fetch history from the channel (Thread)
                history = []
                async for msg in channel.history(limit=30, oldest_first=True):
                    role = "model" if msg.author == self.user else "user"
                    parts = []
                    
                    # 1. Process Text
                    clean_text = msg.clean_content.replace(f'@{self.user.display_name}', '').strip()
                    if clean_text:
                        # Prefix user name for multi-user context
                        text_payload = f"{msg.author.display_name}: {clean_text}" if role == "user" else clean_text
                        parts.append({"text": text_payload})
                    
                    # 2. Process Attachments (only images or text for now)
                    for att in msg.attachments:
                        mime_type = att.content_type or mimetypes.guess_type(att.url)[0]
                        if mime_type and (mime_type.startswith("image/") or mime_type.startswith("text/")):
                            # Download content
                            data = await att.read()
                            parts.append({"inline_data": {"data": data, "mime_type": mime_type}})
                    
                    if parts:
                        history.append({"role": role, "parts": parts})

                if not history:
                    return

                # Multi-turn generation with tool handling
                response = client.models.generate_content(
                    model=MODEL_ID,
                    contents=history,
                    config=types.GenerateContentConfig(tools=[{"function_declarations": TOOL_DECLARATIONS}])
                )

                # Recursive tool handling loop
                while response.candidates[0].content.parts[0].function_call:
                    tool_call = response.candidates[0].content.parts[0].function_call
                    tool_name = tool_call.name
                    tool_args = tool_call.args
                    
                    # Execute tool
                    if tool_name in TOOLS:
                        result = TOOLS[tool_name](**tool_args)
                    else:
                        result = f"Error: Tool '{tool_name}' not found."
                    
                    # Log for debugging
                    print(f"Executing tool {tool_name} with args {tool_args} -> Result: {str(result)[:50]}...")

                    # Feed result back to Gemini
                    history.append(response.candidates[0].content) # Model's call
                    history.append({
                        "role": "user",
                        "parts": [{"function_response": {"name": tool_name, "response": {"result": str(result)}}}]
                    })
                    
                    response = client.models.generate_content(
                        model=MODEL_ID,
                        contents=history,
                        config=types.GenerateContentConfig(tools=[{"function_declarations": TOOL_DECLARATIONS}])
                    )

                # Final response delivery
                final_text = response.text
                await self.send_long_message(channel, final_text)
                
                # Update reactions
                try:
                    await trigger_message.remove_reaction("⏳", self.user)
                    await trigger_message.add_reaction("✅")
                except discord.Forbidden:
                    pass

            except Exception as e:
                print(f"Gemini Processing Error: {e}")
                try:
                    await trigger_message.remove_reaction("⏳", self.user)
                    await trigger_message.add_reaction("❌")
                    await channel.send(f"⚠️ Error: {str(e)}")
                except discord.Forbidden:
                    await channel.send(f"⚠️ Error: {str(e)}")

    async def send_long_message(self, channel, text):
        """Splits long messages by Discord's 2000 character limit."""
        if not text:
            return
        if len(text) <= 2000:
            await channel.send(text)
            return

        chunks = [text[i:i+1990] for i in range(0, len(text), 1990)]
        for chunk in chunks:
            await channel.send(chunk)

bot = GeminiBot(intents=intents)

if __name__ == '__main__':
    bot.run(DISCORD_TOKEN)